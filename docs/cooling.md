# 散热

本页管风扇曲线；占空比不是 RPM，应用曲线后的响应由内核控制。
导航：[约束](#约束) · [源码与验证](#源码与验证)。返回[开发导航](../README.md#开发导航)。

## 约束

只调整自动曲线触发温度，不提供手动转速。
标准 thermal 内核由六区 trip 和 step_wise 控制15级阶梯，占空比不再受旧驱动的5%限速。
面板保留三个锚点，助手通过风扇 cdev 链接识别六区90个 active trip，
只写标准 trip_point_N_temp，全部读回一致后才保存；缺区或部分失败不会保存。
标准 sysfs 没有批量事务，应用中可能短暂切档；hyst 不开放写入。
旧 mainline 私有接口与5.15接口仍兼容，图形按实际内核显示插值或阶梯。
MCU 没有转速计。温度必须保持合法顺序，写入顺序需兼容内核逐项生效。
保存后启动前恢复，无保存文件不改驱动默认，恢复失败不应阻止面板启动。

## 源码与验证

边界见 [fan.go](../internal/board/fan.go)、[helper](../deploy/vim4-manager-helper) 的 fan-curve、fan-restore；
前端 [Cooling](../web/src/pages/Cooling.tsx) 和 [FanPanel](../web/src/FanPanel.tsx)；
行为回归见 [controls.mjs](../web/tests/controls.mjs)。
