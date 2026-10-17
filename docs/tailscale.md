# Tailscale 组网

管理器通过 root 助手管理整机 Tailscale，与 KVM 应用的选择、重启独立。
API 没有认证，面向可信局域网。加入 tailnet 后，访问策略允许的 tailnet 设备也能
访问管理面板 80 和 KVM 界面 8080；应按这个访问范围配置 tailnet/Headscale 策略。

## API

`GET /api/tailscale` 最多等待 10 秒，始终返回以下状态字段：

| 字段 | 含义 |
|---|---|
| `installed` | tailscale、tailscaled 可执行文件均存在 |
| `running` | 守护进程可达；不代表已经连入 tailnet |
| `backendState` | Tailscale BackendState，如 NeedsLogin、Stopped、Running |
| `authURL` | status JSON 的 AuthURL，支持官方服务和 Headscale |
| `hostName`、`dnsName` | Self 中的主机名、DNS 名，DNS 名去除末尾点 |
| `ips` | Tailscale IP 数组，缺省为空数组 |
| `tailnet` | CurrentTailnet.Name |
| `controlURL` | debug prefs 的 ControlURL，缺省 https://controlplane.tailscale.com |
| `version` | status JSON 的 Version |
| `peers`、`peersOnline` | Peer 总数、Online 为真的数量，不包含本机 |
| `devices` | Peer 设备数组，缺省 `[]`；先在线、再按 hostName 升序。每项含 `id,hostName,dnsName,os,ips,online,lastSeen,curAddr,relay,exitNode,active` |
| `job` | 最近一次操作 `{action,running,error}`，从未操作时省略 |

设备 id 来自 Peer.ID；dnsName 去除末尾点，lastSeen 为 RFC3339 字符串（零值为空串），
curAddr 为直连地址（无直连时为空），relay 为 DERP 区域码。

未安装或守护进程不可达时，未知的字符串为空、数量为零；controlURL 使用缺省值。
job 完成后保留结果直到下次操作或管理器重启；成功时 error 为空字符串。
操作结果也通过 `s.record` 写入概览的最近事件。

`POST /api/tailscale` 沿用现有 JSON 限制：`Content-Type: application/json`，请求体最大 4096 字节。

| action | 行为与响应 |
|---|---|
| `install`、`uninstall` | 立即返回 `{"ok":true}`，后台最长 15 分钟，轮询 GET 的 job 查看结果 |
| `up` | 启用并启动守护进程，再连接；返回 `{"ok":true}` |
| `down` | 断开组网，保留守护进程；返回 `{"ok":true}` |
| `login` | 必须同时提供 controlURL，返回 `{"authURL":"…"}`；已连接时地址可能为空 |
| `logout` | 退出登录；返回 `{"ok":true}` |

除 login 外不接受非空 controlURL。地址严格限于 `https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?`，
不接受路径、末尾斜杠、用户信息、查询或片段。官方登录示例：

```json
{"action":"login","controlURL":"https://controlplane.tailscale.com"}
```

Headscale 改用其控制服务器地址，例如 `https://headscale.example:8443`。
Ubuntu 没有 `tailscale set --login-server`，切换控制服务器必须重新 login。
登录命令脱离请求会话，三路标准流均重定向，最长等待授权 10 分钟；助手最多轮询 30 秒，
等待所选服务器的 AuthURL 或 Running。打开返回的 authURL 完成授权，再轮询 GET 确认 Running。
除安装、卸载外，HTTP 操作最多等待 60 秒；同步请求取消会取消其助手。

同一时刻只接受一个 Tailscale 操作，冲突返回 409；参数或操作失败返回 400，状态读取失败返回 500，
错误格式为 `{"error":"…"}`。安装、卸载不随请求结束而取消，但管理器重启会丢失内存任务记录。

| 接口 | 请求与响应 |
|---|---|
| `POST /api/tailscale/ping` | 请求 `{"ip":"100.64.0.2"}`；返回 `{reachable,path,via,latencyMs,lost,sent}` |

Ping 仅接受当前 Peer 的 Tailscale IP（`100.64.0.0/10` 或 `fd7a:115c:a1e0::/48`），未安装时拒绝。
执行 4 次探测，每次超时 3 秒，ping 命令总超时 20 秒，Go 请求最多 30 秒。
reachable 表示收到过 pong；path 为最后一次 pong 的 `direct|derp|peer-relay`，无回复时为空串；
via 为对应直连地址、DERP 区域或 peer-relay 括号内的地址，无回复时为空串。
latencyMs 为各次 pong 的毫秒数数组（支持小数），lost 为超时行数，sent 为回复与超时数之和。
Ping 沿用 JSON 请求限制，同一时刻最多两个请求，超出返回 409；不改变 job、不写最近事件。

## 助手与网络设置

助手固定操作：`tailscale-status`、`tailscale-install`、`tailscale-uninstall`、`tailscale-up`、
`tailscale-down`、`tailscale-login URL`、`tailscale-logout`、`tailscale-ping IP`。未安装时只允许 status、install、uninstall。
安装按 Ubuntu VERSION_CODENAME 获取官方 HTTPS keyring，APT 使用 signed-by 且只刷新 Tailscale 源，
最后 `enable --now tailscaled.service`。卸载先 `disable --now`，再 apt-get remove，删除源和 keyring；
保留 /var/lib/tailscale 中的身份数据，需要退出账户时先 logout。

up 使用 `--accept-dns=false --timeout=20s`，login 使用 `--accept-dns=false --timeout=10m`，
不默认接受子网路由或设置出口节点。已有管理员配置不由面板额外重置。
Tailscale 写操作使用 `/run/lock/vim4-manager-tailscale.lock`，status 和 ping 不加锁；
Go 服务使用独立互斥量，均不占 KVM 切换锁。

## 验证

在仓库根目录运行离线测试，不连接设备：

```sh
go test ./...
go vet ./...
python3 -m unittest discover -s deploy -p 'test_*.py'
```

浏览器回归：运行 `pnpm --dir web dev --port 5188` 后执行
`PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node web/tests/tailscale.mjs`，
使用模拟 API 覆盖安装、自建控制服务器、登录链接、断开/连接、退出确认、失败、后台任务、访问地址复制、设备列表与连接测试。

部署后的功能验证：读取 GET；POST install 后轮询 job；分别登录官方控制服务器和 Headscale，
核对 authURL、controlURL 与 Running；执行 down/up/logout，核对状态转移及守护进程仍在；
安装或卸载进行中读取状态并切换 KVM，确认不互相阻塞。最后检查 uninstall 后包、源和 keyring
均已移除。涉及断开组网的步骤应在本地网络会话中执行。
