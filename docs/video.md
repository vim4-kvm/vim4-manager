# 视频输入

本页管 EDID 与全局 HDR 映射；改变显示声明会影响被控电脑，保存值不证明源恢复。
导航：[EDID](#edid) · [HDR](#hdr) · [源码与边界](#源码与边界)。
返回[开发导航](../README.md#开发导航)。

## EDID

安装管理器不加载新表；明确应用后才加载并保存，相同表已加载时避免重连。
管理器同步 JetKVM 配置，运行中的 JetKVM 先停、更新后再启动，失败尝试恢复旧保存配置并报告。
在应用内另改 EDID 可能与管理器保存值不同，需要重新应用。
最近加载记录只证明尝试加载，不证明 HDMI 信号或主机恢复。

RTK 兼容表曾帮助 Screen Sharing 虚拟屏恢复，但真实 UU 虚拟屏场景仍复现无法恢复，不能承诺修复。
VRR 声明不等于硬件验收；HDR VRR、本地输出及其他应用 VRR 仍待验证。
扩展预设使用 root 管理的清单和校验过的 EDID，网页只能选 ID，不可指定任意文件。

## HDR

全局映射作用于远程画面，HDMI OUT 独立控制；不修改 EDID 或重启 HDMI。
One-KVM 同步设置，UU 可临时覆盖，断开后恢复最新全局值。
不支持真 HDR 的应用、H.264 和截图继续 SDR。
白点和高光曲线可预览，保存后逐帧重载；不能把偏好已保存当作输出已应用。
具体模式和验收见[公共 HDR 文档](https://github.com/vim4-kvm/vim4-kvm/blob/main/docs/hdr.md)。

## 源码与边界

清单与默认项查 [presets.json](../deploy/edid/presets.json)；接口查
[web.go](../internal/web/web.go)、[board/edid.go](../internal/board/edid.go)；
加载和同步查 [helper](../deploy/vim4-manager-helper) 的 select_edid、hdr-mapping、hdr-curve。
前端 [Video](../web/src/pages/Video.tsx) 复用 [EDIDPanel](../web/src/EDIDPanel.tsx)、
[HDRPanel](../web/src/HDRPanel.tsx)，交互回归见 [controls.mjs](../web/tests/controls.mjs)。
主机显示恢复合同统一见[音视频](https://github.com/vim4-kvm/vim4-kvm/blob/main/docs/subsystems/video.md#hdmi-显示器行为)。
