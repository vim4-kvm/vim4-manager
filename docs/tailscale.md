# Tailscale 组网

本页管整机 Tailscale；加入 tailnet 后按访问策略向设备开放管理入口。
导航：[操作顺序](#操作顺序) · [生命周期](#生命周期) · [源码与验证](#源码与验证)。
账户、Host 白名单与协议密钥统一见[账户](auth.md)。返回[开发导航](../README.md#开发导航)。

## 操作顺序

安装后选择官方控制服务器或 Headscale，打开返回的授权链接，再读状态确认已连接。
守护进程运行不等于连入 tailnet。Ubuntu 切换控制服务器需要重新登录，不能用 set 改登录服务器。
断开、退出、卸载及更换已登录控制服务器均要确认；助手在锁内重查原服务器，拒绝过期确认。
会断开组网的操作应从局域网执行。
重连只恢复运行偏好，保留控制服务器和管理员其他设置；登录不接管 DNS，不额外重置路由及出口设置。
卸载保留身份数据，若要退出账户先 logout。

## 生命周期

普通状态直接读只读 LocalAPI，缓存合并请求，不启动 sudo 或授予 operator。
登录任务只保留一个，重试和其他写操作先停止待授权任务。
安装卸载交给独立 systemd 任务，不因 HTTP 结束或管理器重启而停止；提交成功不等于安装成功，应轮询最终任务。
包操作与管理器更新共用锁，不阻塞 KVM 切换；系统其他包管理器仍由 APT/dpkg 锁协调。
普通操作结果留内存，包任务跨管理器重启保留，板子重启清除。
设备状态和 ping 不公开对端底层公网端点；ping 仅测当前 peer，不改变任务或事件。

## 源码与验证

请求与字段查 [web/tailscale.go](../internal/web/tailscale.go)，只读查询查 [board/tailscale.go](../internal/board/tailscale.go)；
助手操作、地址规则、任务期限和安装源查 [helper](../deploy/vim4-manager-helper) 的 tailscale_*。
前端入口见 [TailscalePanel](../web/src/TailscalePanel.tsx) 和 [TailscaleDevices](../web/src/TailscaleDevices.tsx)。
离线入口见[构建与验证](../README.md#构建与验证)，[浏览器回归](../web/tests/tailscale.mjs)只用 fixture。
实机须分别验证官方服务与 Headscale 登录、断开重连、卸载保留身份，以及包任务期间状态读取和 KVM 切换。
