# Local go-fuse module

Source: https://github.com/hanwen/go-fuse tag v2.8.0, commit
ee34567408d6ab557a0169089879ec111bd74408. Original licenses and sources are retained.

`fuse/server.go` replies to parse failures using only the request's unique field
and a header-only error. Unknown opcodes return ENOSYS, including Android GKI
FUSE_CANONICAL_PATH (2016). Never return empty success for that opcode: the
vendor kernel expects a NUL-terminated absolute path and can underflow otherwise.
Truncated requests with a complete unique field also receive an error; shorter
packets cannot be addressed. `fuse/request.go` rejects inconsistent wire lengths.
`fuse/parse_reply_test.go` tests the actual request handler and wire replies.

Upstream v2.12.0 now replies on parse failures, but also changes protocol and
server internals. This small backport keeps the existing v2.8.0 behavior for
valid requests. Review upgrading separately.

The main module replaces go-fuse with this directory. After editing, run
`go mod vendor` in the repository root; never edit vendor directly. Both local
sources and vendor are committed so the existing build remains offline.
Run the regression from this module with
`go test ./fuse -run TestParseFailureReplies` (may need cached upstream test deps).
