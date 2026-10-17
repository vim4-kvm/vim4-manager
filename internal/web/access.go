package web

import (
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/vim4-kvm/vim4-manager/internal/board"
)

func readRequest(method string) bool {
	return method == http.MethodGet || method == http.MethodHead || method == http.MethodOptions
}

// Inspect the actual peer; forwarding headers are untrusted on this listener.
func localWrites(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !readRequest(r.Method) {
			peer, err := netip.ParseAddrPort(r.RemoteAddr)
			if err != nil || board.IsTailscaleAddress(peer.Addr().Unmap()) {
				writeError(w, http.StatusForbidden, errors.New("请通过局域网访问管理面板进行修改"))
				return
			}
			if origin := r.Header.Get("Origin"); origin != "" {
				u, err := url.Parse(origin)
				if err != nil || (u.Scheme != "http" && u.Scheme != "https") || !strings.EqualFold(u.Host, r.Host) {
					writeError(w, http.StatusForbidden, errors.New("不允许跨站修改"))
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

// CheckHost wraps every production route, including assets and read APIs. Never
// resolve an arbitrary supplied hostname: that would permit DNS rebinding.
func CheckHost(service *board.Service, next http.Handler, extra []string) http.Handler {
	hostname, _ := os.Hostname()
	names := map[string]bool{"localhost": true}
	if hostname != "" {
		names[strings.ToLower(hostname)] = true
		names[strings.ToLower(hostname)+".local"] = true
	}
	for _, name := range extra {
		if name = strings.ToLower(strings.TrimSpace(name)); name != "" {
			names[name] = true
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if parsed, port, err := net.SplitHostPort(host); err == nil {
			if _, err := strconv.ParseUint(port, 10, 16); err != nil {
				host = ""
			} else {
				host = parsed
			}
		} else if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
			host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
		} else if strings.Contains(host, ":") {
			host = ""
		}
		host = strings.ToLower(strings.TrimSuffix(host, "."))
		allowed := names[host]
		if ip, err := netip.ParseAddr(host); err == nil {
			ip = ip.Unmap()
			addresses, _ := net.InterfaceAddrs()
			for _, address := range addresses {
				if prefix, err := netip.ParsePrefix(address.String()); err == nil && prefix.Addr().Unmap() == ip {
					allowed = true
					break
				}
			}
		} else if !allowed && host != "" {
			state, err := service.Tailscale(r.Context())
			allowed = err == nil && state.DNSName != "" && strings.EqualFold(host, state.DNSName)
		}
		if !allowed {
			writeError(w, http.StatusForbidden, errors.New("不允许的 Host，请使用板子 IP 或已配置的主机名"))
			return
		}
		next.ServeHTTP(w, r)
	})
}
