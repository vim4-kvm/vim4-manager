# Tailscale 组网

管理器通过 root 助手管理整机 Tailscale，与 KVM 应用的选择、重启独立。
API 没有认证，面向可信局域网。加入 tailnet 后，访问策略允许的 tailnet 设备也能
访问管理面板 80 和 KVM 界面 8080；应按这个访问范围配置 tailnet/Headscale 策略。
管理器拒绝来自 Tailscale IPv4/IPv6 网段的所有写请求（含 IPv4-mapped IPv6），返回 403；
仅检查实际连接来源，不信任转发头。此限制只保护管理器，KVM 应用保持各自访问策略。
Host 必须为板子网卡地址、本机名、其 `.local` 名、localhost、当前 MagicDNS 名，
或通过 `-allowed-hosts name1,name2` 明确配置的主机名；不解析任意 Host 的 DNS。
写请求带 Origin 时还需与 Host 同源。来源限制和操作确认不构成身份认证：
可信局域网中的调用者仍可管理设备，设备名称及 tailnet 地址仍可读取。

## API

`GET /api/tailscale` 最多等待 10 秒，始终返回以下状态字段：

| 字段 | 含义 |
|---|---|
| `installed` | 守护进程可达，或 tailscale、tailscaled 可执行文件均存在 |
| `running` | 守护进程可达；不代表已经连入 tailnet |
| `backendState` | Tailscale BackendState，如 NeedsLogin、Stopped、Running |
| `authURL` | status JSON 的 AuthURL，支持官方服务和 Headscale |
| `hostName`、`dnsName` | Self 中的主机名、DNS 名，DNS 名去除末尾点 |
| `ips` | Tailscale IP 数组，缺省为空数组 |
| `tailnet` | CurrentTailnet.Name |
| `controlURL` | LocalAPI prefs 的 ControlURL，缺省 https://controlplane.tailscale.com |
| `version` | status JSON 的 Version |
| `peers`、`peersOnline` | Peer 总数、Online 为真的数量，不包含本机 |
| `devices` | Peer 设备数组，缺省 `[]`；先在线、再按 hostName 升序。每项含 `id,hostName,dnsName,os,ips,online,lastSeen,relay,exitNode,active` |
| `writable` | 当前连接来源允许写入；tailnet 来源为 false |
| `job` | 最近一次操作 `{action,running,error}`，从未操作时省略 |

设备 id 来自 Peer.ID；dnsName 去除末尾点，lastSeen 为 RFC3339 字符串（零值为空串），
relay 为 DERP 区域码；不返回对端公网 IP、直连端口等底层端点。
管理器直接读取本机 Unix socket 的只读 LocalAPI，三秒共享缓存，同期请求合并，
操作后清除缓存。普通状态轮询不启动 sudo、Python 或 tailscale CLI，也不授予 operator。

未安装或守护进程不可达时，未知的字符串为空、数量为零；controlURL 使用缺省值。
普通操作结果保存在管理器内存；安装、卸载结果存于 root 写入的
`/run/vim4-manager-tailscale-job.json`，可跨管理器重启恢复，重启板子后清除。
成功时 error 为空字符串；安装任务提交和同步操作结果写入概览的最近事件。

`POST /api/tailscale` 沿用现有 JSON 限制：`Content-Type: application/json`，请求体最大 4096 字节。

| action | 行为与响应 |
|---|---|
| `install`、`uninstall` | 立即返回 `{"ok":true}`，后台最长 15 分钟，轮询 GET 的 job 查看结果 |
| `up` | 启用并启动守护进程，再连接；返回 `{"ok":true}` |
| `down` | 需 confirmed:true；断开组网，保留守护进程；返回 `{"ok":true}` |
| `login` | 必须同时提供 controlURL，返回 `{"authURL":"…"}`；已连接时地址可能为空 |
| `logout` | 需 confirmed:true；退出登录；返回 `{"ok":true}` |

uninstall 也要求 confirmed:true。已经登录（含 Stopped）时改用另一控制服务器，
须同时提交 confirmed:true 和 previousControlURL（当前服务器地址）；root 助手在
操作锁内再次比对，拒绝缺失或过期确认。网页先展示原地址、目标地址和断连影响。

除 login 外不接受非空 controlURL。地址严格限于 `https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?`，
不接受路径、末尾斜杠、用户信息、查询或片段。官方登录示例：

```json
{"action":"login","controlURL":"https://controlplane.tailscale.com"}
```

Headscale 改用其控制服务器地址，例如 `https://headscale.example:8443`。
Ubuntu 没有 `tailscale set --login-server`，切换控制服务器必须重新 login。
登录命令由固定 `vim4-manager-tailscale-login.service` 临时单元管理，最长等待授权 10 分钟；
重试前停止上一个登录单元，其他写操作也先停止待授权任务。助手最多轮询 30 秒，
等待所选服务器的 AuthURL 或 Running。打开返回的 authURL 完成授权，再轮询 GET 确认 Running。
除安装、卸载外，HTTP 操作最多等待 60 秒；同步请求取消会取消其助手。

同一时刻只接受一个 Tailscale 操作，冲突返回 409；参数或操作失败返回 400，状态读取失败返回 500，
错误格式为 `{"error":"…"}`。安装、卸载提交独立 systemd 服务后，不随请求结束或管理器重启而取消。
返回的登录链接仅允许无用户信息的 HTTP(S) URL。

| 接口 | 请求与响应 |
|---|---|
| `POST /api/tailscale/ping` | 请求 `{"ip":"100.64.0.2"}`；返回 `{reachable,path,via,latencyMs,lost,sent}` |

Ping 仅接受当前 Peer 的 Tailscale IP（`100.64.0.0/10` 或 `fd7a:115c:a1e0::/48`），未安装时拒绝。
执行 4 次探测，每次超时 3 秒，ping 命令总超时 20 秒，Go 请求最多 30 秒。
reachable 表示收到过 pong；path 为最后一次 pong 的 `direct|derp|peer-relay`，无回复时为空串；
via 只在 DERP 路径返回区域码；其他路径为空，不公开底层直连端点。
latencyMs 为各次 pong 的毫秒数数组（支持小数），lost 为超时行数，sent 为回复与超时数之和。
Ping 沿用 JSON 请求限制，同一时刻最多两个请求，超出返回 409；不改变 job、不写最近事件。

## 助手与网络设置

助手固定操作：`tailscale-status`、`tailscale-install`、`tailscale-uninstall`、`tailscale-up`、
`tailscale-down`、`tailscale-login URL`、`tailscale-logout`、`tailscale-ping IP`。未安装时只允许 status、install、uninstall。
安装按 Ubuntu VERSION_CODENAME 获取官方 HTTPS keyring，APT 使用 signed-by 且只刷新 Tailscale 源，
最后 `enable --now tailscaled.service`。卸载先 `disable --now`，再 apt-get remove，删除源和 keyring；
保留 /var/lib/tailscale 中的身份数据，需要退出账户时先 logout。

up 通过 root LocalAPI 仅将 WantRunning 改为 true，保留当前 Headscale 地址及所有其他配置；
login 使用 `--accept-dns=false --timeout=10m`，
不默认接受子网路由或设置出口节点。已有管理员配置不由面板额外重置。
Tailscale 写操作使用 `/run/lock/vim4-manager-tailscale.lock`，status 和 ping 不加锁；
Go 服务使用独立互斥量，均不占 KVM 切换锁。
安装/卸载在 `vim4-manager-tailscale-package.service` 临时单元执行，最长 15 分钟；
内部操作为 `tailscale-package install|uninstall`。它和管理器的软件更新共用
`/run/lock/vim4-manager-packages.lock`；遇占用立即拒绝，在启动 APT 前报告冲突。
这把锁不覆盖系统或其他应用的包管理器，外部事务仍由 APT/dpkg 自身锁保护。

## 验证

在仓库根目录运行离线测试，不连接设备：

```sh
go test ./...
go vet ./...
python3 -m unittest discover -s deploy -p 'test_*.py'
```

浏览器回归：运行 `pnpm --dir web dev --port 5188` 后执行
`PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node web/tests/tailscale.mjs`，
使用模拟 API 覆盖安装、自建控制服务器、登录链接、断开/连接确认、服务器切换确认、退出确认、只读访问、失败、后台任务、访问地址复制、设备列表与连接测试。

部署后的功能验证：读取 GET；POST install 后轮询 job；分别登录官方控制服务器和 Headscale，
核对 authURL、controlURL 与 Running；执行 down/up/logout，核对状态转移及守护进程仍在；
安装或卸载进行中读取状态并切换 KVM，确认不互相阻塞。最后检查 uninstall 后包、源和 keyring
均已移除。涉及断开组网的步骤应在本地网络会话中执行。
