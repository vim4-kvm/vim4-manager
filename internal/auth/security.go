// Package auth owns the manager's single administrator and revocable sessions.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"net/netip"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/vim4-kvm/vim4-manager/internal/board"
	"github.com/vim4-kvm/vim4-manager/internal/i18n"
	"golang.org/x/crypto/argon2"
)

var ErrBusy = i18n.New("auth.busy", nil)
var ErrCredentials = i18n.New("auth.credentials", nil)
var ErrConfigured = i18n.New("auth.configured", nil)
var ErrUnavailable = i18n.New("auth.unavailable", nil)
var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,32}$`)

// Persist the algorithm and cost with the hash, so later cost changes cannot
// silently reinterpret existing credentials. This release accepts this cost only.
const hashPrefix = "$argon2id$v=19$m=65536,t=2,p=2$"
const dummyHash = hashPrefix + "dW5jb25maWd1cmVkLWR1bW15$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

func Validate(username, password string) error {
	if !usernamePattern.MatchString(username) {
		return i18n.New("auth.usernameRules", nil)
	}
	if !utf8.ValidString(password) || utf8.RuneCountInString(password) < 8 || utf8.RuneCountInString(password) > 128 {
		return i18n.New("auth.passwordRules", nil)
	}
	if username == password {
		return i18n.New("auth.passwordMatchesUsername", nil)
	}
	return nil
}

func Peer(remote string) netip.Addr {
	p, e := netip.ParseAddrPort(remote)
	if e != nil {
		return netip.Addr{}
	}
	return p.Addr().Unmap()
}

func LAN(ip netip.Addr) bool {
	ip = ip.Unmap()
	return ip.IsValid() && !ip.IsLoopback() && !board.IsTailscaleAddress(ip) && (ip.IsPrivate() || ip.IsLinkLocalUnicast())
}

func Secure(r *http.Request) bool {
	return r.TLS != nil || (Peer(r.RemoteAddr).IsLoopback() && r.Header.Get("X-Forwarded-Proto") == "https")
}

func Next(path string) string {
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") || strings.ContainsAny(path, "\\\r\n\t") {
		return "/"
	}
	return path
}

func random(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// Admission counts both running and queued work; cancelled waiters free their slot.
type hasher struct {
	slots    chan struct{}
	admitted chan struct{}
}

func newHasher() *hasher {
	return &hasher{make(chan struct{}, 2), make(chan struct{}, 10)}
}

func (h *hasher) hash(ctx context.Context, password, salt string) (string, error) {
	select {
	case h.admitted <- struct{}{}:
	default:
		return "", ErrBusy
	}
	defer func() { <-h.admitted }()
	select {
	case h.slots <- struct{}{}:
	case <-ctx.Done():
		return "", ctx.Err()
	}
	defer func() { <-h.slots }()
	key := argon2.IDKey([]byte(password), []byte(salt), 2, 64*1024, 2, 32)
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return base64.RawStdEncoding.EncodeToString(key), nil
}

func (h *hasher) encode(ctx context.Context, password string) (string, error) {
	salt := random(16)
	key, e := h.hash(ctx, password, salt)
	return hashPrefix + base64.RawStdEncoding.EncodeToString([]byte(salt)) + "$" + key, e
}

func parseHash(encoded string) (string, string, error) {
	parts := strings.Split(strings.TrimPrefix(encoded, hashPrefix), "$")
	if !strings.HasPrefix(encoded, hashPrefix) || len(parts) != 2 {
		return "", "", errors.New("invalid password hash")
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[0])
	if err != nil || len(salt) < 16 || len(salt) > 64 {
		return "", "", errors.New("invalid password salt")
	}
	key, err := base64.RawStdEncoding.DecodeString(parts[1])
	if err != nil || len(key) != 32 {
		return "", "", errors.New("invalid password hash")
	}
	return string(salt), parts[1], nil
}

func (h *hasher) verify(ctx context.Context, password, encoded string) (bool, error) {
	salt, expected, err := parseHash(encoded)
	if err != nil {
		return false, err
	}
	key, err := h.hash(ctx, password, salt)
	return subtle.ConstantTimeCompare([]byte(key), []byte(expected)) == 1, err
}

type attempts struct {
	failures    int
	last, until time.Time
}

type limiter struct {
	mu       sync.Mutex
	ips      map[string]attempts
	failures []time.Time
}

func bucket(ip netip.Addr) string {
	ip = ip.Unmap()
	if ip.IsLoopback() {
		return "loopback"
	}
	if ip.Is6() {
		return netip.PrefixFrom(ip.WithZone(""), 64).Masked().String()
	}
	return ip.String()
}

func (l *limiter) check(ip netip.Addr, now time.Time) (int, bool) {
	return l.inspect(ip, now, false)
}

func (l *limiter) begin(ip netip.Addr, now time.Time) (int, bool) {
	return l.inspect(ip, now, true)
}

func (l *limiter) inspect(ip netip.Addr, now time.Time, attempt bool) (int, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.prune(now)
	a := l.ips[bucket(ip)]
	if attempt && a.failures > 0 {
		a.last = now
		l.ips[bucket(ip)] = a
	}
	return max(0, int(a.until.Sub(now).Seconds()+0.999)), len(l.failures) > 50
}

func (l *limiter) prune(now time.Time) {
	for k, a := range l.ips {
		if now.Sub(a.last) >= 10*time.Minute {
			delete(l.ips, k)
		}
	}
	i := 0
	for i < len(l.failures) && now.Sub(l.failures[i]) >= 10*time.Minute {
		i++
	}
	l.failures = l.failures[i:]
}

func (l *limiter) result(ip netip.Addr, now time.Time, ok bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.prune(now)
	if l.ips == nil {
		l.ips = map[string]attempts{}
	}
	k := bucket(ip)
	if ok {
		delete(l.ips, k)
		return
	}
	a := l.ips[k]
	a.failures++
	a.last = now
	if a.failures >= 5 {
		a.until = now.Add(min(30*time.Second*time.Duration(1<<min(a.failures-5, 5)), 15*time.Minute))
	}
	l.ips[k] = a
	l.failures = append(l.failures, now)
}
