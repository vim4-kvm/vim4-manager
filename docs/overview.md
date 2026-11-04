# 概览

本页管连接图、趋势和事件的解释；未知读数不能当作零或已连接。
导航：[连接与供电](#连接与供电) · [趋势与事件](#趋势与事件) · [源码](#源码)。
返回[开发导航](../README.md#开发导航)。

## 连接与供电

连接图对应实体接口，板内线条只表示逻辑路径。USB-C 的供电与键鼠状态分别判断，
RJ45 不映射 Wi-Fi 或 USB 网卡。读取失败保留旧状态并标灰，没有读数显示未知。
设备在线不证明每个接口都已连接，也没有会话数、编码格式和码率汇总可供展示。

供电额度不是实时电流或整机功耗。当前 Linux 初始化结果优先，固件快照并列保留；
历史合同只能标明沿用，不能当实时协商。来源 PDO 上限不等于实际 RDO 请求额度。
合同来自本次初始化完成日志，不代表运行期间实时合约；没有 Linux TCPM 时也不能推断其已接管。
配套 PD 读取助手必须在管理器 helper 前安装，安装不重启 PD。
实际电流、USB-C/VIN 供电分担未测量。

## 趋势与事件

历史和事件仅存内存，服务重启清空；短于采样间隔的往返变化可能漏记。
应用外操作可能只表现为服务状态变化。网络吞吐汇总物理网卡，不含隧道或虚拟接口。
GPU 含义与权限见[GPU 利用率](gpu-utilization.md)。
CPU 动态功耗为频率驻留模型乘忙碌比例的近似，区间内频率与负载相关性未知；
不含漏电、GPU、编码器、内存及供电损耗，未经仪表校准。
模型缺失不能用额定电压替代，重置或在线核变化留空，重新建立连续采样后恢复。
零值只代表估算动态功耗为零。

## 源码

页面 [Overview](../web/src/pages/Overview.tsx)，连接图 [DeviceConnections](../web/src/components/DeviceConnections.tsx)；
PD 优先级、缓存和字段查 [power.go](../internal/board/power.go)，初始化实现见
[板级 PD](https://github.com/vim4-kvm/vim4-kvm/blob/main/board/vim4pd.py)。
模型和采样查 [cpu_power.go](../internal/board/cpu_power.go)、[history.go](../internal/board/history.go)、
[events.go](../internal/board/events.go)，助手查 cpu_power_snapshot。
回归见 [overview.mjs](../web/tests/overview.mjs)、[power.mjs](../web/tests/power.mjs)。
