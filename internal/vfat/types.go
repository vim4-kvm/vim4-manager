package vfat

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"time"
)

type SourceID string

type Node struct {
	Name     string
	Size     int64
	Mtime    time.Time
	Dir      bool
	Mode     fs.FileMode // Non-regular types are reported in Layout.Skipped.
	SourceID SourceID
	Children []Node
}

type Tree struct{ Children []Node }
type Skipped struct{ Path, Reason string }
type ClusterRange struct{ Start, End uint32 } // Inclusive, in chain order.

type Source interface {
	ReadAt(id SourceID, p []byte, off int64) (int, error)
}

type ScanOptions struct {
	ExcludeName string
	MaxEntries  int
	MaxDepth    int
}

// Scan uses Lstat and never descends into symbolic links. SourceIDs are relative
// slash-separated paths. ExcludeName is excluded at every directory level.
func Scan(ctx context.Context, root string, opts ScanOptions) (Tree, error) {
	if opts.MaxEntries == 0 {
		opts.MaxEntries = 1000000
	}
	if opts.MaxDepth == 0 {
		opts.MaxDepth = 128
	}
	if opts.MaxEntries < 1 || opts.MaxDepth < 1 {
		return Tree{}, fmt.Errorf("invalid scan limits")
	}
	info, err := os.Lstat(root)
	if err != nil {
		return Tree{}, err
	}
	if !info.IsDir() {
		return Tree{}, fmt.Errorf("scan root is not a directory")
	}
	count := 0
	var walk func(string, int) ([]Node, error)
	walk = func(rel string, depth int) ([]Node, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if depth > opts.MaxDepth {
			return nil, fmt.Errorf("scan depth limit at %s", rel)
		}
		f, err := os.Open(filepath.Join(root, rel))
		if err != nil {
			return nil, err
		}
		defer f.Close()
		var nodes []Node
		for {
			batch, readErr := f.ReadDir(128)
			if readErr != nil && readErr != io.EOF {
				return nil, readErr
			}
			for _, entry := range batch {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				if entry.Name() == opts.ExcludeName {
					continue
				}
				count++
				if count > opts.MaxEntries {
					return nil, fmt.Errorf("scan entry limit exceeded")
				}
				p := filepath.Join(rel, entry.Name())
				info, err := os.Lstat(filepath.Join(root, p))
				if err != nil {
					return nil, err
				}
				n := Node{Name: entry.Name(), Size: info.Size(), Mtime: info.ModTime(), Dir: info.IsDir(), Mode: info.Mode(), SourceID: SourceID(filepath.ToSlash(p))}
				if n.Dir {
					n.Size = 0
					n.Children, err = walk(p, depth+1)
					if err != nil {
						return nil, err
					}
				}
				nodes = append(nodes, n)
			}
			if readErr == io.EOF {
				break
			}
		}
		sort.Slice(nodes, func(i, j int) bool { return nodes[i].Name < nodes[j].Name })
		return nodes, nil
	}
	nodes, err := walk("", 0)
	return Tree{Children: nodes}, err
}

func addCluster(ranges []ClusterRange, c uint32) []ClusterRange {
	if len(ranges) > 0 && ranges[len(ranges)-1].End+1 == c {
		ranges[len(ranges)-1].End = c
		return ranges
	}
	return append(ranges, ClusterRange{c, c})
}

func overlaps(a, b []ClusterRange) bool {
	for _, x := range a {
		for _, y := range b {
			if x.Start <= y.End && y.Start <= x.End {
				return true
			}
		}
	}
	return false
}
