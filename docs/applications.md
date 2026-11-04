# KVM 界面

本页管应用选择与安全切换；当前要点是先释放共享设备，再启目标应用。
导航：[切换](#切换) · [源码与验证](#源码与验证)。返回[开发导航](../README.md#开发导航)。

## 切换

应用互斥使用采集、编码、HID 和回环后端。停止完成后才启动目标，不能仅依赖 systemd Conflicts。
启动非 One-KVM 应用前先完成其延后的 USB 配置恢复；失败或超时不启动目标。
跨应用重启同样需要检查共享介质；同应用重启沿用自身规则。

进入 PiKVM 或离开其介质配置前，若仍有挂载介质，先在被控电脑安全弹出。
页面等待不会强制弹出；刷新、离页、取消、读失败、应用被别处改变或等待超时都会终止等待。
重新连接不恢复旧请求。未知介质状态不能视为空盘。
具体介质操作见[虚拟介质](media.md)，认证入口见[网关](auth.md#kvm-网关)。

## 源码与验证

页面见 [Applications](../web/src/pages/Applications.tsx)，状态与等待见 [api.ts](../web/src/api.ts)；
限定操作见 [helper](../deploy/vim4-manager-helper) 的 select、restart、restore_onekvm_usb、check_pikvm_media。
等待时限和取消回归见 [media.mjs](../web/tests/media.mjs)。
