# 底层服务

本页管维护入口；只能重启后端明确允许维护的服务。
导航：[约束](#约束) · [源码](#源码)。返回[开发导航](../README.md#开发导航)。

## 约束

重启 HDMI 前先停运行中的应用，完成后再启动。
USB gadget、PD 和 CPU 频率服务只显示状态，不提供重启；重新绑定或协商会断开被控机连接，应由板级工具处理。
Wave5 隔离告警需要区分未知与已隔离；接口不自动重启，前端专门告警仍待实现。

## 源码

单元和可维护范围见 [units.go](../internal/board/units.go)，重启顺序见
[helper](../deploy/vim4-manager-helper) 的 restart，隔离字段见 [encoder.go](../internal/board/encoder.go)。
页面见 [Services](../web/src/pages/Services.tsx)，交互回归见 [actions.mjs](../web/tests/actions.mjs)。
