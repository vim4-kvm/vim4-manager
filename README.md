# vim4-manager

VIM4 KVM 管理面板：选择开机启用的网页 KVM 界面（NanoKVM-Pro 或 JetKVM），
查看 HDMI、USB、温度等板子状态和底层服务。监听 **80** 端口，KVM 界面仍在 8080。

两个界面共用 HDMI 采集、硬件编码器、HID 端点和 8080 端口，同一时间只运行一个。
nanokvm.service 与 vim4-kvm.service 互相 Conflicts=；启动一个会停止另一个。

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

- `select nanokvm|jetkvm`：先禁用另一个、启用并重启所选，最后 sync。
- `restart nanokvm.service|vim4-kvm.service|vim4-kvm-hdmi.service`：重启 HDMI
  采集前先停止运行中的界面，完成后再启动。

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
- 风扇只显示，不提供调速。
- HDMI 分辨率按接收器报告显示；YUV420 时接收器报告的水平像素数为一半，已换算。
