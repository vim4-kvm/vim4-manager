# 更新

本页管软件更新和内核选择；更新应用不能替代匹配的平台依赖。
导航：[软件](#软件) · [内核](#内核) · [源码与验证](#源码与验证)。
返回[开发导航](../README.md#开发导航)。

## 软件

管理器直接更新支持的组件，其他应用从各自设置页安装。
助手校验下载、包身份和递增版本，拒绝会改变其他包的 APT 计划。
只重启正在运行的目标，不切换当前 KVM；管理器升级后刷新页面。
PiKVM 仍有介质时先安全弹出。开发版只接收高于基础正式版的后续正式更新。
包操作与 Tailscale 安装共用锁，不能把提交后台任务当作完成。

## 内核

清单须通过完整产物校验才可切换；缺清单时不提供切换项。
切换需要重启，重启前拒绝挂载介质并停止应用。
启动失败仍需串口或 OOWOW 恢复，没有自动回退。
厂商/主线身份来自清单，版本与日期只是显示，不代替资格校验。
两内核共用管理器及网关，各应用数据仍保留各自目录。

## 源码与验证

组件及版本规则见 [updates.go](../internal/board/updates.go)，内核清单与请求见
[board/kernel.go](../internal/board/kernel.go)、[web/kernel.go](../internal/web/kernel.go)；
包校验和操作入口见 [helper](../deploy/vim4-manager-helper)。
构建发布条件查 [workflow](../.github/workflows/vim4-release.yml)。
回归见 [updates.mjs](../web/tests/updates.mjs)、[kernel-screens.mjs](../web/tests/kernel-screens.mjs)。
