// Package vfat synthesizes partitionless FAT32 volumes without storing file data
// or a full FAT. Scan (or construct a Tree), Build a Layout, and attach a Source
// with NewVolume. Wrap that volume in NewMemoryOverlay or OpenFileOverlay. After
// the host has unmounted it, Parse the overlay and pass the successful Result to
// BuildPlan. Plans describe operations; they never modify the source directory.
// All FAT timestamps are UTC, rounded down to two seconds. Callers must keep the
// snapshot and Source stable for the entire session, and stop writes before Parse.
package vfat
