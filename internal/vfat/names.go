package vfat

import (
	"encoding/binary"
	"fmt"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

var le = binary.LittleEndian

func validName(name string) bool {
	if name == "" || name == "." || name == ".." || !utf8.ValidString(name) || strings.HasSuffix(name, " ") || strings.HasSuffix(name, ".") {
		return false
	}
	if len(utf16.Encode([]rune(name))) > 255 {
		return false
	}
	for _, r := range name {
		if r < 32 || r == 127 || strings.ContainsRune("\"*/:<>?\\|", r) {
			return false
		}
	}
	return true
}

func shortPart(s string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(s) {
		if r == ' ' || r == '.' {
			continue
		}
		if r > 127 || !strings.ContainsRune("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$%'-_@~`!(){}^#&", r) {
			r = '_'
		}
		b.WriteRune(r)
	}
	return b.String()
}

func splitName(s string) (string, string) {
	if i := strings.LastIndexByte(s, '.'); i > 0 {
		return s[:i], s[i+1:]
	}
	return s, ""
}

func packShort(base, ext string) [11]byte {
	var out [11]byte
	for i := range out {
		out[i] = ' '
	}
	copy(out[:8], base)
	copy(out[8:], ext)
	if out[0] == 0xe5 {
		out[0] = 0x05
	}
	return out
}

func directShort(name string) ([11]byte, byte, bool) {
	b, e := splitName(name)
	ub, ue := shortPart(b), shortPart(e)
	if len(ub) == 0 || len(ub) > 8 || len(ue) > 3 || strings.ToUpper(b) != ub || strings.ToUpper(e) != ue {
		return [11]byte{}, 0, false
	}
	var flags byte
	if b != ub {
		if b != strings.ToLower(b) {
			return [11]byte{}, 0, false
		}
		flags |= 8
	}
	if e != ue {
		if e != strings.ToLower(e) {
			return [11]byte{}, 0, false
		}
		flags |= 16
	}
	return packShort(ub, ue), flags, true
}

func makeShort(name string, used map[[11]byte]bool) ([11]byte, byte, bool) {
	if s, f, ok := directShort(name); ok && !used[s] {
		used[s] = true
		return s, f, false
	}
	b, e := splitName(name)
	b, e = shortPart(b), shortPart(e)
	if b == "" {
		b = "_"
	}
	if len(e) > 3 {
		e = e[:3]
	}
	for n := 1; ; n++ {
		tail := fmt.Sprintf("~%d", n)
		prefix := b
		if len(prefix) > 8-len(tail) {
			prefix = prefix[:8-len(tail)]
		}
		s := packShort(prefix+tail, e)
		if !used[s] {
			used[s] = true
			return s, 0, true
		}
	}
}

func checksum(name []byte) byte {
	var sum byte
	for _, b := range name {
		sum = (sum >> 1) | (sum << 7)
		sum += b
	}
	return sum
}

var lfnOffsets = [...]int{1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30}

func longEntries(name string, short [11]byte) []byte {
	u := utf16.Encode([]rune(name))
	count := (len(u) + 12) / 13
	out := make([]byte, count*32)
	for i := 0; i < count; i++ {
		ordinal := count - i
		e := out[i*32 : (i+1)*32]
		e[0] = byte(ordinal)
		if i == 0 {
			e[0] |= 0x40
		}
		e[11] = 0x0f
		e[13] = checksum(short[:])
		for j, off := range lfnOffsets {
			k := (ordinal-1)*13 + j
			v := uint16(0xffff)
			if k < len(u) {
				v = u[k]
			} else if k == len(u) {
				v = 0
			}
			le.PutUint16(e[off:], v)
		}
	}
	return out
}

func fatTime(t time.Time, location *time.Location) (uint16, uint16) {
	t = t.In(location)
	if t.Year() < 1980 {
		t = time.Date(1980, 1, 1, 0, 0, 0, 0, location)
	}
	if t.Year() > 2107 {
		t = time.Date(2107, 12, 31, 23, 59, 58, 0, location)
	}
	return uint16((t.Year()-1980)<<9 | int(t.Month())<<5 | t.Day()), uint16(t.Hour()<<11 | t.Minute()<<5 | t.Second()/2)
}

func decodeTime(date, clock uint16, location *time.Location) time.Time {
	return time.Date(1980+int(date>>9), time.Month((date>>5)&15), int(date&31), int(clock>>11), int((clock>>5)&63), int(clock&31)*2, 0, location).UTC()
}

func shortEntry(name [11]byte, flags, attr byte, first uint32, size int64, t time.Time, location *time.Location) []byte {
	b := make([]byte, 32)
	copy(b, name[:])
	b[11] = attr
	b[12] = flags
	d, c := fatTime(t, location)
	le.PutUint16(b[14:], c)
	le.PutUint16(b[16:], d)
	le.PutUint16(b[18:], d)
	le.PutUint16(b[22:], c)
	le.PutUint16(b[24:], d)
	le.PutUint16(b[20:], uint16(first>>16))
	le.PutUint16(b[26:], uint16(first))
	le.PutUint32(b[28:], uint32(size))
	return b
}

func decodeShort(e []byte) string {
	b := append([]byte(nil), e[:11]...)
	if b[0] == 5 {
		b[0] = 0xe5
	}
	base, ext := strings.TrimRight(decodeOEM(b[:8]), " "), strings.TrimRight(decodeOEM(b[8:]), " ")
	if e[12]&8 != 0 {
		base = strings.ToLower(base)
	}
	if e[12]&16 != 0 {
		ext = strings.ToLower(ext)
	}
	if ext != "" {
		base += "." + ext
	}
	return base
}

// FAT does not record an OEM code page. CP437 is the default for short names;
// UTF-16 long names remain independent of the host's legacy code page.
func decodeOEM(b []byte) string {
	const high = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ "
	runes := []rune(high)
	var out strings.Builder
	for _, c := range b {
		if c < 128 {
			out.WriteByte(c)
		} else {
			out.WriteRune(runes[int(c)-128])
		}
	}
	return out.String()
}
