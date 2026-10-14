# vim4-manager

VIM4 KVM 管理面板：选择开机启用的网页 KVM 界面（NanoKVM、JetKVM 或 One-KVM），
查看 HDMI、USB、温度等板子状态和底层服务。监听 **80** 端口，KVM 界面仍在 8080。

三个界面共用 HDMI 采集、硬件编码器、HID 端点和 8080 端口，同一时间只运行一个。
nanokvm.service、vim4-kvm.service 与 one-kvm.service 互相 Conflicts=；管理器会等待旧服务退出后
再启动另一个，避免端口和编码器仍被旧进程占用。

## 结构

| 路径 | 作用 |
|---|---|
| cmd/vim4-manager | 入口，嵌入 web/dist |
| internal/board | systemd 单元、sysfs/procfs 读数、切换策略 |
| internal/web | HTTP API 与静态文件 |
| web | React + Vite 前端 |
| deploy/vim4-manager-helper | root 辅助程序，只接受固定操作 |

服务以 khadas 运行，用 CAP_NET_BIND_SERVICE 绑定 80 端口；特权操作通过 sudoers
只允许调用 /usr/libexec/vim4-manager-helper：

- `select nanokvm|jetkvm|onekvm`：先禁用并停止其余应用、启用并重启所选，最后 sync。
- `restart nanokvm.service|vim4-kvm.service|one-kvm.service|vim4-kvm-hdmi.service`：重启 HDMI
  采集前先停止运行中的界面，完成后再启动。

- `hdr-curve WHITE PEAK`：校验后原子写入 /etc/default/vim4-kvm-hdr（HDR 输入映射为
  SDR 的 SDR 白和高光上限，单位尼特），再按上条方式重启 HDMI 采集；重启失败时恢复
  原配置并重新启动采集。

USB gadget、PD 和 CPU 频率服务只显示状态，不提供重启：重新绑定和重新协商会断开
被控机的 USB 连接，交给板级工具处理。

API 没有认证，面向可信局域网。POST 只接受 application/json，跨站表单无法触发切换。

## 构建

```sh
pnpm --dir web install --frozen-lockfile && pnpm --dir web build
go test ./... && go build -trimpath -o vim4-manager ./cmd/vim4-manager
python3 -m unittest discover -s deploy -p 'test_*.py'
```

正式构建和打包由工作区完成：`python3 tools/workspace.py build manager`，组件包
vim4-manager 由 tools/ubuntu-build.py 生成，tools/board.py deploy 部署。

前端开发：`pnpm --dir web dev`，API 代理到 http://192.168.50.210（可用
VIM4_MANAGER 覆盖）。

## 已知限制

- 状态每 3 秒轮询一次；切换期间页面显示进行中，完成后刷新。
- 风扇只显示，不提供调速。MCU 风扇没有转速计，显示的是占空比和驱动自动曲线
  （与 drivers/misc/khadas-mcu.c 的 mcu_fan_auto_speed_percent 保持一致），不是 RPM。
- CPU、内存、温度、风扇趋势每 5 秒采样，内存中保留 15 分钟，服务重启后清空。
- HDMI 分辨率按接收器报告显示；YUV420 时接收器报告的水平像素数为一半，已换算。
