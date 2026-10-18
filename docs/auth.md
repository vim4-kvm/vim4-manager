# 管理器账户

管理面板（80）的 `/api/*` 需要管理员会话，未登录返回 401 JSON。
静态页面公开，启动时检查会话并跳转 `/__vim4/login`，保留当前哈希路由。
当前只有一个管理员账户；KVM 界面（8080）仍由各应用直接提供，沿用各自登录方式。
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
`/__vim4/login` 和 `/__vim4/assets/*` 公开；此阶段只在管理器监听器提供。
`next` 仅接受站内绝对路径，拒绝 `//`、反斜线和换行/制表符；无效值回到概览。

## 会话与限速

Cookie 为 `vim4_session`，32 字节随机令牌，HttpOnly、SameSite=Lax、Path=/，安全连接加 Secure。
服务端只保存令牌的 SHA-256。最多 20 个会话，超出时淘汰最久未活动的设备。

| 每次请求的实际来源 | 空闲有效期 | 绝对有效期 |
|---|---|---|
| 局域网 | 7 天 | 30 天 |
| 其他（含 tailnet、回环） | 1 小时 | 24 小时 |

切换到非局域网来源时立即按短档重新检查。持续请求每分钟更新活动时间；
活动时间合并落盘，每 5 分钟一次，正常退出时也保存。创建、吊销和改账户立即保存。
吊销会取消该会话正在处理的 API 请求。重启与升级保留有效会话。

每 IP 连续失败 5 次锁定 30 秒，其后每次失败翻倍，最长 15 分钟；
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
