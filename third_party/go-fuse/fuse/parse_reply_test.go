// Copyright 2026 the Go-FUSE Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package fuse

import (
	"encoding/binary"
	"io"
	"log"
	"os"
	"testing"
	"time"
)

// Exercise the actual server path with a pipe replacing /dev/fuse. No mount
// privileges or Linux kernel are needed to check the wire reply.
func TestParseFailureReplies(t *testing.T) {
	for _, tc := range []struct {
		name           string
		opcode         uint32
		size, declared int
		status         Status
	}{
		{"canonical_path", 2016, 40, 40, ENOSYS},
		{"unknown", 0x7fffffff, 40, 40, ENOSYS},
		{"short_read", _OP_READ, 40, 40, EIO},
		{"short_xattr", _OP_GETXATTR, 40, 40, EIO},
		{"length_mismatch", _OP_READ, 80, 79, EIO},
		{"short_header", _OP_READ, 16, 16, EIO},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reader, writer, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer reader.Close()
			defer writer.Close()
			reader.SetReadDeadline(time.Now().Add(time.Second))
			server := &Server{mountFd: int(writer.Fd()), opts: &MountOptions{Logger: log.New(io.Discard, "", 0)}}
			input := make([]byte, tc.size)
			binary.NativeEndian.PutUint32(input, uint32(tc.declared))
			binary.NativeEndian.PutUint32(input[4:], tc.opcode)
			const unique = uint64(0x1020304050607080)
			binary.NativeEndian.PutUint64(input[8:], unique)
			req := &requestAlloc{}
			req.setInput(input)
			if code := server.handleRequest(req); code != OK {
				t.Fatal(code)
			}
			reply := make([]byte, 16)
			if _, err := io.ReadFull(reader, reply); err != nil {
				t.Fatal(err)
			}
			if binary.NativeEndian.Uint32(reply) != 16 || int32(binary.NativeEndian.Uint32(reply[4:])) != -int32(tc.status) || binary.NativeEndian.Uint64(reply[8:]) != unique {
				t.Fatalf("reply %x", reply)
			}
		})
	}
}
