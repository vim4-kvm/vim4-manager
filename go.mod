module github.com/vim4-kvm/vim4-manager

go 1.25.0

replace github.com/hanwen/go-fuse/v2 => ./third_party/go-fuse

require (
	github.com/hanwen/go-fuse/v2 v2.8.0
	golang.org/x/sys v0.28.0
)
