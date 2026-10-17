// Package nasdisk connects a stable NAS snapshot to a virtual FAT disk.
package nasdisk

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/vfat"
	"golang.org/x/sys/unix"
)

const PrivateName = ".vim4-nasdisk"

// Source keeps the NAS directory open, also preventing a normal NAS unmount
// while the LUN itself refers to a different (FUSE) filesystem.
type Source struct {
	root       *os.File
	nodes      map[vfat.SourceID]vfat.Node
	mu         sync.Mutex
	changed    map[vfat.SourceID]bool
	rechecking map[vfat.SourceID]bool
	closed     bool
	cancel     context.CancelFunc
	ctx        context.Context
	rechecks   sync.WaitGroup
}

func relative(p string) ([]string, error) {
	if p == "" || strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\\\x00") {
		return nil, fmt.Errorf("invalid relative path")
	}
	parts := strings.Split(p, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || part == PrivateName {
			return nil, fmt.Errorf("invalid path component")
		}
	}
	return parts, nil
}

func openBelow(root *os.File, p string, flags int) (*os.File, error) {
	parts, err := relative(p)
	if err != nil {
		return nil, err
	}
	fd, err := unix.Dup(int(root.Fd()))
	if err != nil {
		return nil, err
	}
	for i, part := range parts {
		mode := unix.O_RDONLY | unix.O_DIRECTORY
		if i == len(parts)-1 {
			mode = flags
		}
		next, e := unix.Openat(fd, part, mode|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
		unix.Close(fd)
		if e != nil {
			return nil, e
		}
		fd = next
	}
	return os.NewFile(uintptr(fd), p), nil
}

func OpenSource(root string, tree vfat.Tree) (*Source, error) {
	directory, err := openDirectory(root)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Source{root: directory, nodes: map[vfat.SourceID]vfat.Node{}, changed: map[vfat.SourceID]bool{}, rechecking: map[vfat.SourceID]bool{}, ctx: ctx, cancel: cancel}
	s.loadTree(tree)
	return s, nil
}

func (s *Source) loadTree(tree vfat.Tree) {
	var add func([]vfat.Node)
	add = func(nodes []vfat.Node) {
		for _, n := range nodes {
			s.nodes[n.SourceID] = n
			add(n.Children)
		}
	}
	add(tree.Children)
}

func openDirectory(name string) (*os.File, error) {
	if !strings.HasPrefix(name, "/") {
		return nil, fmt.Errorf("directory must be absolute")
	}
	root, err := os.Open("/")
	if err != nil {
		return nil, err
	}
	defer root.Close()
	return openBelow(root, strings.TrimPrefix(name, "/"), unix.O_RDONLY|unix.O_DIRECTORY)
}

func (s *Source) Close() error {
	s.mu.Lock()
	s.closed = true
	s.cancel()
	s.mu.Unlock()
	s.rechecks.Wait()
	return s.root.Close()
}

func (s *Source) ReadAt(id vfat.SourceID, p []byte, off int64) (int, error) {
	s.mu.Lock()
	bad := s.changed[id] || s.rechecking[id] || s.closed
	s.mu.Unlock()
	node, ok := s.nodes[id]
	if bad || !ok || node.Dir {
		return 0, &sourceReadError{Path: "/" + string(id), Err: syscall.EIO}
	}
	f, err := openBelow(s.root, string(id), unix.O_RDONLY)
	if err != nil {
		s.logInvalid(node, nil, "before-read/open", err)
		return 0, &sourceReadError{Path: "/" + string(id), Err: err}
	}
	defer f.Close()
	info, statErr := f.Stat()
	if !matchesSnapshot(node, info, statErr) {
		f.Close()
		s.invalidate(node, info, "before-read", statErr)
		return 0, &sourceReadError{Path: "/" + string(id), Err: syscall.EIO}
	}
	n, err := f.ReadAt(p, off)
	// Validate after reading too: never publish bytes from a concurrently changed file.
	info, statErr = f.Stat()
	if !matchesSnapshot(node, info, statErr) {
		clear(p)
		f.Close()
		s.invalidate(node, info, "after-read", statErr)
		return 0, &sourceReadError{Path: "/" + string(id), Err: syscall.EIO}
	}
	s.mu.Lock()
	bad = s.changed[id] || s.rechecking[id]
	s.mu.Unlock()
	if bad {
		clear(p)
		return 0, &sourceReadError{Path: "/" + string(id), Err: syscall.EIO}
	}
	if err != nil && err != io.EOF {
		s.logInvalid(node, info, "read", err)
		return n, &sourceReadError{Path: "/" + string(id), Err: err}
	}
	return n, err
}

func matchesSnapshot(node vfat.Node, info os.FileInfo, err error) bool {
	return err == nil && info != nil && info.Mode().IsRegular() && info.Size() == node.Size && info.ModTime().Equal(node.Mtime)
}

func (s *Source) logInvalid(node vfat.Node, info os.FileInfo, phase string, err error) {
	actual := "unavailable"
	if info != nil {
		actual = fmt.Sprintf("size=%d mtime_ns=%d mode=%s", info.Size(), info.ModTime().UnixNano(), info.Mode())
	}
	var errno syscall.Errno
	errors.As(err, &errno)
	if err == nil {
		err = fmt.Errorf("snapshot metadata mismatch")
	}
	log.Printf("nasdisk source invalid: SourceID=%q phase=%s expected={size=%d mtime_ns=%d mode=%s} actual={%s} errno=%d error=%v", node.SourceID, phase, node.Size, node.Mtime.UnixNano(), node.Mode, actual, errno, err)
}

func (s *Source) invalidate(node vfat.Node, info os.FileInfo, phase string, err error) {
	s.logInvalid(node, info, phase, err)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.changed[node.SourceID] || s.rechecking[node.SourceID] {
		return
	}
	s.rechecking[node.SourceID] = true
	s.rechecks.Add(1)
	go s.recheck(node, phase)
}

func (s *Source) recheck(node vfat.Node, phase string) {
	defer s.rechecks.Done()
	timer := time.NewTimer(1100 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-s.ctx.Done():
		return
	case <-timer.C:
	}
	var info os.FileInfo
	file, err := openBelow(s.root, string(node.SourceID), unix.O_RDONLY)
	if err == nil {
		info, err = file.Stat()
		file.Close()
	}
	valid := matchesSnapshot(node, info, err)
	if !valid {
		s.logInvalid(node, info, phase+"/recheck", err)
	} else {
		log.Printf("nasdisk source recheck passed: SourceID=%q phase=%s", node.SourceID, phase)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.changed[node.SourceID] = err == nil && !valid
	delete(s.rechecking, node.SourceID)
}

// Scan traverses directory descriptors, rejecting symlink replacement at every
// descent. Its progress callback runs synchronously and may cancel the scan.
func (s *Source) Scan(ctx context.Context, progress func(int)) (vfat.Tree, error) {
	count := 0
	var walk func(*os.File, string, int) ([]vfat.Node, error)
	walk = func(dir *os.File, prefix string, depth int) ([]vfat.Node, error) {
		if depth > 64 {
			return nil, fmt.Errorf("directory depth exceeds 64")
		}
		var nodes []vfat.Node
		for {
			entries, err := dir.ReadDir(128)
			if err != nil && err != io.EOF {
				return nil, err
			}
			for _, entry := range entries {
				if e := ctx.Err(); e != nil {
					return nil, e
				}
				if entry.Name() == PrivateName {
					continue
				}
				count++
				if count > 1000000 {
					return nil, fmt.Errorf("scan entry limit exceeded")
				}
				if progress != nil {
					progress(count)
				}
				id := prefix + entry.Name()
				if entry.Type() != 0 && !entry.IsDir() {
					nodes = append(nodes, vfat.Node{Name: entry.Name(), Mode: entry.Type(), SourceID: vfat.SourceID(id)})
					continue
				}
				file, e := openBelow(s.root, id, unix.O_RDONLY)
				if e != nil {
					return nil, e
				}
				info, e := file.Stat()
				file.Close()
				if e != nil {
					return nil, e
				}
				n := vfat.Node{Name: entry.Name(), Size: info.Size(), Mtime: info.ModTime(), Dir: info.IsDir(), Mode: info.Mode(), SourceID: vfat.SourceID(id)}
				if n.Dir {
					child, e := openBelow(s.root, id, unix.O_RDONLY|unix.O_DIRECTORY)
					if e != nil {
						return nil, e
					}
					n.Size = 0
					n.Children, e = walk(child, id+"/", depth+1)
					child.Close()
					if e != nil {
						return nil, e
					}
				}
				s.nodes[n.SourceID] = n
				nodes = append(nodes, n)
			}
			if err == io.EOF {
				break
			}
		}
		sort.Slice(nodes, func(i, j int) bool { return nodes[i].Name < nodes[j].Name })
		return nodes, nil
	}
	fd, err := unix.Openat(int(s.root.Fd()), ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return vfat.Tree{}, err
	}
	dir := os.NewFile(uintptr(fd), "scan")
	defer dir.Close()
	nodes, err := walk(dir, "", 0)
	return vfat.Tree{Children: nodes}, err
}

func WritableReserve(available int64) (int64, error) {
	reserve := min(available-(2<<30), int64(64<<30))
	if reserve < 256<<20 {
		return 0, fmt.Errorf("NAS 可用空间不足：保留 2 GiB 后至少需要 256 MiB")
	}
	return reserve, nil
}

func Label(name string) string {
	var b strings.Builder
	for _, c := range strings.ToUpper(name) {
		if c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == ' ' || c == '_' || c == '-' {
			b.WriteRune(c)
			if b.Len() == 11 {
				break
			}
		}
	}
	label := strings.TrimSpace(b.String())
	if label == "" {
		return "NAS"
	}
	return label
}
