# 管理器账户

管理面板（80）的 `/api/*` 需要管理员会话，未登录返回 401 JSON。
静态页面公开，启动时检查会话并跳转 `/__vim4/login`，保留当前哈希路由。
当前只有一个管理员账户；管理器在 8080 提供 KVM 登录网关，与 80 共享会话。
不提供 TLS、TOTP 或多用户。MCP、VNC 等接口仍使用各自密钥。

## 首次设置与登录

未配置时在登录页创建账户，默认用户名 `admin`。用户名为 1–32 个 ASCII 字母、数字、
点、下划线或连字符；密码为 8–128 个 Unicode 字符，不能与用户名相同。
只有实际连接来源属于 RFC1918、链路本地或 IPv6 ULA 才允许网页首次设置。
回环、Tailscale 100.64/10 与 fd7a:115c:a1e0::/48 不属于局域网；IPv4-mapped 地址按 IPv4 判断。
回环转发及 tailnet 用户使用下方命令行设置。

Host 白名单、写请求 Origin 同源检查和 POST JSON 限制继续生效。
登录后 Tailscale 来源可修改设置，`writable` 恒为 true。
登录页只在非局域网且连接不安全时提示「此连接未加密，密码可能被窃听。外网访问请使用 HTTPS。」
实际 TLS 连接或回环来源携带 `X-Forwarded-Proto: https` 视为安全；其他来源的转发头不受信任。

## API

所有请求体与响应为 JSON，成功写请求返回 `{ok:true}`。

| 方法与路径 | 参数与结果 |
|---|---|
| `GET /__vim4/api/auth/state` | 公开；`configured,authenticated,username,secure,setupAllowed,retryAfter,hostname`；未登录不返回账户用户名 |
| `POST /__vim4/api/auth/setup` | 公开，仅未配置且局域网；`{username,password}`，创建并设置会话 Cookie；已配置返回 409 |
| `POST /__vim4/api/auth/login` | 公开；`{username,password}`，成功设置 Cookie；错误返回 401 |
| `POST /__vim4/api/auth/logout` | 会话；`{}`，吊销本会话并清除 Cookie |
| `GET /api/account/sessions` | 会话；`{username,passwordChanged,sessions}`；设备含 `id,address,userAgent,created,lastActive,current`，时间为 RFC3339 |
| `POST /api/account/revoke` | 会话；`{id}`，吊销指定设备 |
| `POST /api/account/logout-others` | 会话；`{}`，保留本会话，退出其他设备 |
| `POST /api/account/password` | 会话；`{currentPassword,password}`，修改密码并吊销其他会话 |
| `POST /api/account/username` | 会话；`{currentPassword,username}`，修改用户名并吊销其他会话 |

修改账户时当前密码错误返回 403（保留本设备登录），也计入登录限速。
`/__vim4/login` 和 `/__vim4/assets/*` 公开；80 与 8080 都提供登录页、静态资源和 auth API。
`next` 仅接受站内绝对路径，拒绝 `//`、反斜线和换行/制表符；无效值回到概览。

## 会话

Cookie 为 `vim4_session`，32 字节随机令牌，HttpOnly、SameSite=Lax、Path=/，安全连接加 Secure。
服务端只保存令牌的 SHA-256。最多 20 个会话，超出时淘汰最久未活动的设备。

| 每次请求的实际来源 | 空闲有效期 | 绝对有效期 |
|---|---|---|
| 局域网 | 7 天 | 30 天 |
| 其他（含 tailnet、回环） | 1 小时 | 24 小时 |

切换到非局域网来源时立即按短档重新检查。持续请求每分钟更新活动时间；
活动时间合并落盘，每 5 分钟一次，正常退出时也保存。创建、吊销和改账户立即保存。
吊销会取消该会话正在处理的 API 与代理请求，包括已升级的 WebSocket 和流式响应。
重启与升级保留有效会话。

## KVM 网关

`-kvm-listen :8080` 提供网页入口，`-kvm-backend 127.0.0.1:8081` 指定 HTTP 后端。
四个应用需要配套升级为回环 8081 监听并关闭网页登录；管理器不修改应用配置。
管理器单元已有 `CAP_NET_BIND_SERVICE` 供 80 使用，8080 不需要额外特权。
旧应用占用 8080 时不影响 80；每 2 秒重试，首次失败记录「KVM 网关等待 8080 端口释放」，
绑定成功记录「KVM 网关已启动」。管理器和应用包可以按任意顺序升级，不要求包依赖版本下限。

所有入口复用 Host 白名单。未登录 HTML GET（Accept 包含 text/html，非 WebSocket）
302 到本端口 `/__vim4/login?next=<原路径与查询>`，其他请求（含 WebSocket 握手）401 JSON。
登录页缺失或无效 next 时回到 KVM 根路径。`/redfish` 及子路径始终 404。

免会话白名单仅限当前唯一启用 NanoKVM 或 One-KVM 时的 **`/api/mcp` 根端点**，
由应用继续强制校验 MCP Bearer 密钥；未配置管理器账户时仍为 401。
其他应用或无法确定当前应用时 MCP 路径返回 401。
**子路径不免会话**：两个应用的 config、key 等管理端点使用网页登录鉴权，
关闭网页登录后不足以保护这些端点，未登录一律 401。登录后按普通应用接口转发。
这是对设计稿前缀白名单的安全收窄；VNC 等独立端口继续使用各自密钥。

非 GET/HEAD/OPTIONS 与 WebSocket 握手携带 Origin 时，须与实际请求的协议、Host 和端口一致，
否则 403。协议遵循上述 HTTPS/可信回环转发判断。不对应用上传套用管理器 JSON 或大小限制。
转发保留原 Host；清除客户端的 `X-Forwarded-*`、`Forwarded`、`X-Real-IP`、
`X-KVMD-User`、`X-KVMD-Passwd`、`Authorization`，仅 MCP 根端点保留 Authorization。
按实际连接回写 `X-Forwarded-For`、`X-Forwarded-Proto`、`X-Real-IP`。
删除所有 `vim4_session` Cookie，保留应用 Cookie；删除响应 `Access-Control-Allow-*`。

代理使用 `FlushInterval: -1`，逐块发送 MJPEG 等流，不设 ReadTimeout/WriteTimeout，
仅保留 10 秒 ReadHeaderTimeout。每个需登录的代理请求使用会话派生 context，
吊销或过期时取消并关闭升级连接；长连接期间每分钟检查来源档位、绝对有效期并更新活动时间，
升级后仍然生效。免会话 MCP 的连接寿命由应用密钥鉴权负责。
WebRTC UDP 媒体不经过网关，关闭信令不能保证所有应用立即停止已有点对点媒体。

后端不可达时 HTML GET 返回 502 提示页「KVM 界面未运行，可在管理面板启用或重启」，
链接 `http://<host>/#/apps`，使用登录页颜色变量并跟随系统深浅色，无外部资源；其他请求 502 JSON。
SSH 应急访问后端（需 SSH 账户）：

```sh
ssh -L 8081:127.0.0.1:8081 khadas@<板子地址>
```

随后打开 `http://127.0.0.1:8081`；该隧道直接访问已关闭网页登录的后端。

## 登录限速

IPv4 按单个地址、IPv6 按 /64 网段归桶；连续失败 5 次锁定 30 秒，其后每次失败翻倍，最长 15 分钟；
成功清零，10 分钟无尝试后衰减清零。所有回环地址共用一桶，不信任 `X-Forwarded-For`。
锁定返回 429 和 `retryAfter` 秒数，不计算密码哈希。
全局 10 分钟内超过 50 次失败，每次尝试先等待 5 秒，仍允许正确登录。
用户名错误与密码错误统一提示并执行同样的哈希计算。
Argon2id 使用 64 MiB、2 次迭代、2 路并行；最多 2 个计算、8 个等待，超额返回 503。

## 忘记密码与文件

```sh
sudo vim4-manager set-password
sudo vim4-manager set-password --username admin
```

终端交互输入两遍密码且不回显；非终端 stdin 读取一行。省略用户名时保留现有用户名，
尚未配置则使用 `admin`。命令吊销全部会话，运行中的管理器每秒检查 mtime，2 秒内重新加载。
root 执行后文件属主恢复为 khadas。

`auth.json` 与 `sessions.json` 原子写入 `/var/lib/vim4-manager`，权限 0600；目录由
systemd `StateDirectory` 以 0700 创建。`auth.json` 含用户名、密码哈希、会话版本与密码修改时间。
服务器和 `set-password` 都支持 `--state-dir PATH`，供离线测试使用。

离线验证：`go test ./...`；启动本地前端后运行 `node web/tests/auth.mjs`。
浏览器测试使用模拟 API，支持 `TEST_URL` 和 `PLAYWRIGHT_MODULE`，截图保存到
工作区 `logs/unified-auth/shots-b/`。其他浏览器测试通过测试 fixture 模拟已登录状态。
