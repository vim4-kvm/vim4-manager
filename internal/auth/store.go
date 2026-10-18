package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const DefaultDirectory = "/var/lib/vim4-manager"

type Credentials struct {
	Username        string    `json:"username"`
	Hash            string    `json:"hash"`
	Version         string    `json:"sessionsVersion"`
	PasswordChanged time.Time `json:"passwordChanged"`
}

type Session struct {
	ID         string    `json:"id"`
	Digest     string    `json:"digest"`
	Address    string    `json:"address"`
	UserAgent  string    `json:"userAgent"`
	Created    time.Time `json:"created"`
	LastActive time.Time `json:"lastActive"`
	ctx        context.Context
	cancel     context.CancelFunc
}

type sessionFile struct {
	Version  string     `json:"sessionsVersion"`
	Sessions []*Session `json:"sessions"`
}

type Store struct {
	mu          sync.Mutex
	dir         string
	credentials Credentials
	sessions    map[string]*Session
	stamp       time.Time
	saved       time.Time
	now         func() time.Time
	hashes      *hasher
	limits      limiter
	loadError   error
}

func atomicJSON(path string, value any) error {
	data, e := json.Marshal(value)
	if e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".auth-*")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if _, e = f.Write(data); e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e != nil {
		return e
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), path)
}

func Open(dir string) (*Store, error) {
	if e := os.MkdirAll(dir, 0700); e != nil {
		return nil, e
	}
	s := &Store{
		dir:      dir,
		sessions: map[string]*Session{},
		now:      time.Now,
		hashes:   newHasher(),
	}
	if e := s.reload(); e != nil {
		return nil, e
	}
	b, e := os.ReadFile(filepath.Join(dir, "sessions.json"))
	if e != nil && !os.IsNotExist(e) {
		return nil, e
	}
	if e == nil {
		var disk sessionFile
		if e = json.Unmarshal(b, &disk); e != nil {
			return nil, e
		}
		if disk.Version == s.credentials.Version && disk.Version != "" {
			for _, v := range disk.Sessions {
				if s.now().Sub(v.Created) < 30*24*time.Hour && s.now().Sub(v.LastActive) < 7*24*time.Hour {
					v.ctx, v.cancel = context.WithCancel(context.Background())
					s.sessions[v.Digest] = v
				}
			}
		}
	}
	return s, nil
}

func (s *Store) reload() error {
	info, e := os.Stat(filepath.Join(s.dir, "auth.json"))
	if os.IsNotExist(e) {
		if s.credentials.Version != "" {
			s.revokeExcept("")
			s.credentials = Credentials{}
		}
		return nil
	}
	if e != nil {
		return e
	}
	if info.ModTime() == s.stamp {
		return nil
	}
	b, e := os.ReadFile(filepath.Join(s.dir, "auth.json"))
	if e != nil {
		return e
	}
	var c Credentials
	if e = json.Unmarshal(b, &c); e != nil {
		return e
	}
	if c.Version == "" || c.Hash == "" || !usernamePattern.MatchString(c.Username) {
		return errors.New("invalid auth.json")
	}
	if _, _, err := parseHash(c.Hash); err != nil {
		return err
	}
	if c.Version != s.credentials.Version {
		s.revokeExcept("")
	}
	s.credentials = c
	s.stamp = info.ModTime()
	return nil
}

// Run reloads externally replaced credentials and coalesces activity writes.
func (s *Store) Run(ctx context.Context) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	defer s.Close()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.mu.Lock()
			s.loadError = s.reload()
			if e := s.loadError; e != nil {
				s.revokeExcept("")
				slog.Error("reload credentials", "error", e)
			}
			if s.now().Sub(s.saved) >= 5*time.Minute {
				if e := s.save(); e != nil {
					slog.Error("save sessions", "error", e)
				}
			}
			s.mu.Unlock()
		}
	}
}

func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.save()
}

func (s *Store) save() error {
	rows := make([]*Session, 0, len(s.sessions))
	for _, v := range s.sessions {
		rows = append(rows, v)
	}
	e := atomicJSON(filepath.Join(s.dir, "sessions.json"), sessionFile{s.credentials.Version, rows})
	if e == nil {
		s.saved = s.now()
	}
	return e
}

func (s *Store) Credentials() Credentials {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.credentials
}

func (s *Store) Configured() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.credentials.Version != "" || s.loadError != nil
}

func (s *Store) revokeExcept(id string) {
	for k, v := range s.sessions {
		if v.ID != id {
			v.cancel()
			delete(s.sessions, k)
		}
	}
}

func digest(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (s *Store) create(ip netip.Addr, agent string) (string, error) {
	if len(s.sessions) >= 20 {
		var oldest *Session
		for _, v := range s.sessions {
			if oldest == nil || v.LastActive.Before(oldest.LastActive) {
				oldest = v
			}
		}
		oldest.cancel()
		delete(s.sessions, oldest.Digest)
	}
	token := random(32)
	v := &Session{
		ID:         random(16),
		Digest:     digest(token),
		Address:    ip.String(),
		UserAgent:  agent,
		Created:    s.now(),
		LastActive: s.now(),
	}
	v.ctx, v.cancel = context.WithCancel(context.Background())
	s.sessions[v.Digest] = v
	if e := s.save(); e != nil {
		v.cancel()
		delete(s.sessions, v.Digest)
		return "", e
	}
	return token, nil
}

func (s *Store) Authenticate(token string, ip netip.Addr) *Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.loadError != nil {
		return nil
	}
	v := s.sessions[digest(token)]
	if v == nil {
		return nil
	}
	idle, absolute := time.Hour, 24*time.Hour
	if LAN(ip) {
		idle, absolute = 7*24*time.Hour, 30*24*time.Hour
	}
	if s.now().Sub(v.LastActive) >= idle || s.now().Sub(v.Created) >= absolute {
		v.cancel()
		delete(s.sessions, v.Digest)
		return nil
	}
	v.LastActive = s.now()
	copy := *v
	return &copy
}

func (s *Store) Sessions() []Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Session, 0, len(s.sessions))
	for _, v := range s.sessions {
		out = append(out, *v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastActive.After(out[j].LastActive) })
	return out
}

func (s *Store) Revoke(id string, others bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, v := range s.sessions {
		if (others && v.ID != id) || (!others && v.ID == id) {
			v.cancel()
			delete(s.sessions, k)
		}
	}
	return s.save()
}

type LockedError struct{ RetryAfter int }

func (e *LockedError) Error() string {
	return "尝试次数过多"
}

func (s *Store) verify(ctx context.Context, ip netip.Addr, username, password string) (Credentials, error) {
	retry, slow := s.limits.begin(ip, s.now())
	if retry > 0 {
		return Credentials{}, &LockedError{retry}
	}
	if slow {
		timer := time.NewTimer(5 * time.Second)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			return Credentials{}, ctx.Err()
		}
	}
	c := s.Credentials()
	s.mu.Lock()
	unavailable := s.loadError != nil
	s.mu.Unlock()
	if unavailable {
		return c, ErrUnavailable
	}
	encoded := c.Hash
	if encoded == "" {
		encoded = dummyHash
	}
	ok, e := s.hashes.verify(ctx, password, encoded)
	if e != nil {
		return c, e
	}
	ok = ok && c.Username == username && c.Version != ""
	s.limits.result(ip, s.now(), ok)
	if !ok {
		return c, ErrCredentials
	}
	return c, nil
}

func (s *Store) Login(ctx context.Context, ip netip.Addr, agent, username, password string) (string, error) {
	c, e := s.verify(ctx, ip, username, password)
	if e != nil {
		return "", e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if c.Version != s.credentials.Version {
		return "", ErrCredentials
	}
	return s.create(ip, agent)
}

func (s *Store) Setup(ctx context.Context, ip netip.Addr, agent, username, password string) (string, error) {
	if !LAN(ip) {
		return "", errors.New("请在局域网内完成首次设置")
	}
	if s.Configured() {
		return "", ErrConfigured
	}
	if e := Validate(username, password); e != nil {
		return "", e
	}
	hash, e := s.hashes.encode(ctx, password)
	if e != nil {
		return "", e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.loadError != nil {
		return "", ErrUnavailable
	}
	if s.credentials.Version != "" {
		return "", ErrConfigured
	}
	if e = s.writeCredentials(Credentials{username, hash, random(16), s.now()}); e != nil {
		return "", e
	}
	return s.create(ip, agent)
}

func (s *Store) writeCredentials(c Credentials) error {
	if e := atomicJSON(filepath.Join(s.dir, "auth.json"), c); e != nil {
		return e
	}
	s.credentials = c
	info, e := os.Stat(filepath.Join(s.dir, "auth.json"))
	if e == nil {
		s.stamp = info.ModTime()
	}
	return e
}

// SetPassword also invalidates persisted sessions through a fresh version, so an
// offline reset cannot resurrect sessions saved by the old running process.
func (s *Store) SetPassword(ctx context.Context, username, password string) error {
	if username == "" {
		username = s.Credentials().Username
		if username == "" {
			username = "admin"
		}
	}
	if e := Validate(username, password); e != nil {
		return e
	}
	hash, e := s.hashes.encode(ctx, password)
	if e != nil {
		return e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if e = s.writeCredentials(Credentials{username, hash, random(16), s.now()}); e != nil {
		return e
	}
	s.revokeExcept("")
	return s.save()
}

func (s *Store) Change(ctx context.Context, ip netip.Addr, current *Session, password, newUsername, newPassword string) error {
	c, e := s.verify(ctx, ip, s.Credentials().Username, password)
	if e != nil {
		return e
	}
	updated := c
	if newUsername != "" {
		if !usernamePattern.MatchString(newUsername) || newUsername == password {
			return errors.New("用户名无效或与密码相同")
		}
		updated.Username = newUsername
	} else {
		if e = Validate(c.Username, newPassword); e != nil {
			return e
		}
		updated.Hash, e = s.hashes.encode(ctx, newPassword)
		if e != nil {
			return e
		}
		updated.PasswordChanged = s.now()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if c.Version != s.credentials.Version || s.sessions[current.Digest] == nil {
		return ErrCredentials
	}
	updated.Version = random(16)
	if e = s.writeCredentials(updated); e != nil {
		return e
	}
	s.revokeExcept(current.ID)
	return s.save()
}
