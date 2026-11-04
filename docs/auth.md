# 管理器账户

本页管账户、统一网关与 HTTPS；管理器登录不替代独立协议密钥。
导航：[账户](#账户) · [KVM 网关](#kvm-网关) · [HTTPS](#https) · [恢复与验证](#恢复与验证)。
返回[开发导航](../README.md#开发导航)。

## 账户

静态登录资源公开，管理 API 需要管理员会话。仅一个管理员，不提供多用户或 TOTP。
网页首次设置只允许实际局域网来源；回环转发和 tailnet 须经命令行初始化。
登录后 tailnet 可修改设置，但会话按非局域网的较短有效期检查。
Host 白名单和写请求同源校验仍生效，不能凭登录放宽。
实际 TLS 或可信回环转发才视为安全，不能信任外部来源伪造的转发头。

会话跨管理器与网关共享，重启升级保留有效会话。
改账户需当前密码并吊销其他设备；密码错误仍保留本设备会话，同时计入限速。
吊销或到期会取消 API、流式代理和升级后的 WebSocket；
WebRTC UDP 不经网关，关闭信令不能保证已有点对点媒体立即停止。
来源变化会重新检查有效期，不沿用局域网长档。
登录失败限速与哈希并发限制见 [internal/auth](../internal/auth)，不要在文档复制安全参数。

## KVM 网关

应用后端须回环监听并关闭自身网页登录；管理器不代改应用配置。
旧应用占住网关地址时，管理器仍可使用并重试绑定，因此两者可任意顺序升级。
未登录的网页导航跳到本端口登录页，其他请求和 WebSocket 握手返回认证错误。
后端不可达时按网页或 API 返回错误，不能把旧界面当作当前应用。

唯一启用 NanoKVM 或 One-KVM 时，仅 MCP 根端点可免管理器会话，且须已配置管理器账户；
应用仍校验 Bearer 密钥。子路径含配置和密钥管理，不能扩大白名单。
其他应用或无法确定当前应用时拒绝免会话 MCP；独立 VNC 等继续使用各自密钥。

网关剥离客户端伪造的身份、转发头和管理器会话 Cookie，仅 MCP 根保留 Authorization。
跨源响应头不透传；应用上传不套用管理器 JSON 或大小限制。
转发、拒绝路径、Host/Origin 细则和断连处理见 [kvm.go](../internal/web/kvm.go)；
公开入口和参数见 [main.go](../cmd/vim4-manager/main.go)。
SSH 转发可应急直达后端，但该隧道绕过网页登录；地址从运行配置查，不照抄公共入口。

## HTTPS

管理器和网关均支持 HTTPS。客户端需导入本机 CA 才能信任自签链；
CA 下载公开，私钥留在状态目录。地址变化会更新叶证书，保留 CA。
Tailscale 已连接且允许签发时，由配套助手申请证书并按 SNI 选择；需同时升级 helper。
HTTP 可在 HTTPS 会话中关闭，远程请求重定向，回环工具仍可用；不使用 HSTS。
证书持久化、续签与入口约束见 [board/https.go](../internal/board/https.go) 和 [web/https.go](../internal/web/https.go)。

## 恢复与验证

忘记密码使用程序的 set-password 子命令，关闭 HTTP 后的本机恢复使用 set-http；
选项查 [PasswordCommand](../internal/auth/command.go) 和 [HTTPCommand](../internal/auth/http_command.go) 或子命令帮助。
密码交互不回显；重置吊销全部会话，运行服务会重载文件。
文件位置和权限以 [auth](../internal/auth) 与[服务单元](../deploy/vim4-manager.service)为准。

API 请求体查 [auth.go](../internal/web/auth.go)，Host 与写入检查查 [access.go](../internal/web/access.go)。
离线入口见[构建与验证](../README.md#构建与验证)；
浏览器 fixture 见 [auth.mjs](../web/tests/auth.mjs)、[https.mjs](../web/tests/https.mjs)，不证明真实证书信任和跨网络断连。
