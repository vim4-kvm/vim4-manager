# 虚拟介质

本页管共享 LUN 的挂载与弹出；以实际 LUN 为准，避免同时在应用和管理器操作。
导航：[操作顺序](#操作顺序) · [边界与源码](#边界与源码)。返回[开发导航](../README.md#开发导航)。

## 操作顺序

从按来源分组的镜像库选择介质；占用中的 LUN 不能替换。
先在被控电脑停止使用并安全卸载，再确认弹出。没有主机防弹出锁不代表已经停止写入。
只清空 LUN，不强制弹出或解绑整个 USB。弹出后保留空存储接口，不自动恢复 USB 网卡。
首次增加存储接口可能短暂重连 USB；One-KVM 的功能组合需在该应用内调整端点预算。

JetKVM 和 ISO 的只读约束由共享助手执行。
其他应用自己的镜像选择可能不同步，管理器显示的实际 LUN 才是判断依据。
读取失败不等于弹出。切换等待见[应用](applications.md#切换)；
数据盘编辑先读[数据盘](disks.md)。

## 边界与源码

页面 [MediaPanel](../web/src/MediaPanel.tsx)，接口 [web.go](../internal/web/web.go)；
镜像目录、校验和固定操作查 [helper](../deploy/vim4-manager-helper) 的 media_mount、attach_media、media_eject。
助手拒绝越界、链接和特殊文件，并在锁内重查应用及介质标识。
共享模块来自[板级 vim4media](https://github.com/vim4-kvm/vim4-kvm/blob/main/board/vim4media.py)，应先安装匹配板级包；
网页升级不会代装平台依赖。回归见 [media.mjs](../web/tests/media.mjs) 和 [助手测试](../deploy/test_media_management.py)。
