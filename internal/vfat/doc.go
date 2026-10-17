// Package vfat synthesizes partitionless FAT32 volumes without storing file data
// or a full FAT. Scan (or construct a Tree), Build a Layout, and attach a Source
// with NewVolume. Wrap that volume in NewMemoryOverlay or OpenFileOverlay. After
// the host has unmounted it, Parse the overlay and pass the successful Result to
// BuildPlan. Plans describe operations; they never modify the source directory.
// FAT timestamps use a fixed UTC offset (zero by default), rounded down to two
// seconds. Build and Parse must use the same offset. Callers must keep the
// snapshot and Source stable for the entire session, and stop writes before Parse.
// New layouts align both FATs to 4 KiB and the data area to the cluster size
// (at least 4 KiB). Persist Options.LayoutVersion explicitly; LayoutLegacy
// reproduces old geometry and overlay IDs for recovery.
package vfat
