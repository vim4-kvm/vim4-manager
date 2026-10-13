// Package vim4manager embeds the built frontend.
package vim4manager

import "embed"

// Assets holds web/dist after `pnpm build`; a placeholder keeps Go builds valid.
//
//go:embed all:web/dist
var Assets embed.FS
