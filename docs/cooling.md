# 散热

本页管风扇曲线；占空比不是 RPM，应用曲线后不会立即达到目标。
导航：[约束](#约束) · [源码与验证](#源码与验证)。返回[开发导航](../README.md#开发导航)。

## 约束

只调整自动曲线触发温度，固定占空比及爬升速度属于驱动，不提供手动转速。
MCU 没有转速计。温度必须保持合法顺序，写入顺序需兼容驱动逐项校验。
保存后启动前恢复，无保存文件不改驱动默认，恢复失败不应阻止面板启动。

## 源码与验证

边界见 [fan.go](../internal/board/fan.go)、[helper](../deploy/vim4-manager-helper) 的 fan-curve、fan-restore；
前端 [Cooling](../web/src/pages/Cooling.tsx) 和 [FanPanel](../web/src/FanPanel.tsx)；
行为回归见 [controls.mjs](../web/tests/controls.mjs)。
