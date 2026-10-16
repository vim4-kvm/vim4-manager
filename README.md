# vim4-manager

VIM4 KVM 管理面板：选择开机启用的网页 KVM 界面（NanoKVM、JetKVM、One-KVM 或 PiKVM），
查看 HDMI、USB、温度等板子状态和底层服务，调节 EDID、HDR 映射与风扇曲线。
页面按侧边栏分为概览、KVM 界面、视频输入、散热、网络和底层服务（`#/cooling` 等哈希路由）。监听 **80** 端口，KVM 界面仍在 8080。

四个界面共用 HDMI 采集、硬件编码器、HID 端点和 8080 端口，同一时间只运行一个。
PiKVM 使用 vim4-pikvm.service；管理器会等待旧服务退出后
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

- `select nanokvm|jetkvm|onekvm|pikvm`：先禁用并停止其余应用、启用并重启所选，最后 sync。
- `restart nanokvm.service|vim4-kvm.service|one-kvm.service|vim4-pikvm.service|vim4-kvm-hdmi.service`：重启 HDMI
  采集前先停止运行中的界面，完成后再启动。

- `hdr-curve WHITE PEAK`：校验后原子写入 /etc/default/vim4-kvm-hdr（HDR 输入映射为
  SDR 的 SDR 白和高光上限，单位尼特），再按上条方式重启 HDMI 采集；重启失败时恢复
  原配置并重新启动采集。

- `fan-curve LOW MID HIGH`：校验后按驱动接受的顺序写入 /sys/class/fan 的三个触发温度，
  切换为自动调速，原子保存到 /etc/default/vim4-kvm-fan。
- `fan-restore`：vim4-manager.service 启动前以 root 执行（ExecStartPre=-+），恢复保存的曲线；
  没有保存文件时不改动驱动默认值，失败不阻止面板启动。

USB gadget、PD 和 CPU 频率服务只显示状态，不提供重启：重新绑定和重新协商会断开
被控机的 USB 连接，交给板级工具处理。
PiKVM 有已挂载介质时，切换和重启会在改变服务状态前拒绝；先在 USB 主机安全弹出。

KVM 界面页显示板级共享虚拟介质的文件名、只读/可写和 USB 连接状态，与当前应用无关。
进入 PiKVM 或离开其介质配置时若磁盘仍挂载，可选择「弹出后继续切换」：当前会话保持
运行，在被控电脑安全弹出后，页面检测到空 LUN 才提交普通切换请求。特权助手再次核对
挂载状态，不提供强制弹出。等待仅属于当前页面，取消、离开、刷新、状态读取失败、
其他操作改变当前应用或超过 5 分钟都会取消；重新连接不会恢复旧等待。
`GET /api/status` 的 `media.known=false` 表示读取失败，不等于已经弹出。
浏览器回归：运行本地前端后执行 `node web/tests/media.mjs`（可设置 PLAYWRIGHT_MODULE）。

同一区域提供已有镜像列表、只读/可写挂载和弹出。列表汇总 NanoKVM、JetKVM、
One-KVM、PiKVM 的 ISO/IMG 目录及已有共享数据盘；不创建、上传、删除或格式化文件。
默认只读，ISO 固定为只读光盘，JetKVM 固定只读。已有介质时拒绝替换；
One-KVM 的 USB 网卡/HID 组合不被修改，端点不足时先在应用内调整功能。
NanoKVM/JetKVM 首次连接存储可将 NCM 换成存储，会短暂重连 USB；已有存储接口时直接插入介质。
弹出只写共享 LUN 的 file 属性，不解绑 UDC、不使用 forced_eject。必须先确认主机已
停止使用并安全卸载；主机防弹出锁仍存在则失败。主机没有设置锁不代表已停止写入。
弹出后保留空的存储接口，不自动恢复 USB 网卡。应用自身的镜像选项可能不同步，
以管理器读取的实际共享 LUN 为准，避免同时在两处操作介质。

`GET /api/media` 返回固定目录内的镜像标识、来源和大小；`POST /api/media/mount`
接受 `app`、`image`、`cdrom`、`readOnly`，再次检查运行中的应用与空 LUN。
`POST /api/media/eject` 接受当前 `media.token` 和 `confirmed: true`，拒绝过期的磁盘标识。
助手逐级禁止符号链接，并拒绝硬链接、特殊文件、越界路径和小于 512 字节的镜像。

API 没有认证，面向可信局域网。POST 只接受 application/json，跨站表单无法触发切换。

## EDID 兼容性预设

面板可选择 RTK UHD HDR 4K60、厂商 VIM4 4K60 或 VIM4 1080p60。
RTK 表在当前 Mac 的 Screen Sharing 虚拟屏进退测试中可恢复 HDMI；这不保证所有电脑兼容。
实际 UU 客户端连接并创建虚拟屏后，用户仍复现无法恢复，RTK 不能作为该场景的修复保证。
安装管理器不改变现有 EDID，点击「应用预设」才加载并保存；相同配置已加载时不触发重连。

`GET /api/edid` 返回清单、板级保存值、当前 tvserver 会话的最近加载记录及 JetKVM 同步状态；
加载记录不是 HDMI 信号或主机恢复成功的证明。`POST /api/edid` 接受 `{"id":"RTK-CONTROL"}`。
应用时同步 `/var/lib/jetkvm/config.json` 的 EDID 字段，保留其他设置；运行中的 JetKVM
先停止再修改、最后启动。失败时尝试恢复原保存配置并报告结果。其他 KVM 无需重启。
在应用自身界面另改 EDID 后，可能与管理器保存值不同，需要重新应用预设。

扩展预设：将经校验的 128/256 字节 EDID 文件加入 `deploy/edid/`，在
`deploy/edid/presets.json` 增加唯一 `id`、显示 `name`、`description` 及安装后的绝对 `file` 路径，
打包会安装到 `/usr/share/vim4-manager/edid/`。保留 `VIM4-4K60` 默认项。
清单由 root 管理，网页只能选择清单 ID，不能指定文件路径或上传任意内容。

## 构建与验证

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

更新页从各应用的公开 GitHub Release 查询版本。NanoKVM、JetKVM、One-KVM
使用自己的设置页安装；PiKVM 和管理面板可以直接在管理器中更新。
下载经过大小和 SHA256 校验，特权助手再验证包名、ARM64 架构和递增版本，
拒绝会修改其他包的 APT 安装计划。PiKVM 挂载虚拟介质时必须先安全弹出。
更新只重启正在运行的目标服务，不切换当前 KVM 应用；管理器更新后需刷新网页。
发布清单固定为各仓库的 `<package>-latest.json`，下载目录由 systemd 创建在
`/var/lib/vim4-manager/updates`。该功能沿用管理面板现有的局域网访问边界。

`.github/workflows/vim4-release.yml` 在推送和 PR 时构建验证；手动勾选 publish
或推送 `release-*` 标签才创建 Release。发布流程见主仓库的
[Ubuntu 构建说明](https://github.com/vim4-kvm/vim4-kvm/blob/main/docs/ubuntu-build.md)。

- 状态每 3 秒轮询一次；切换期间页面显示进行中，完成后刷新。
- 风扇曲线只能调整三个触发温度（起转 35–80、中速、全速 ≤100 °C，相邻至少差 5 °C）；
  对应占空比 35/70/100% 及起转前 5%/25% 两段由驱动固定（drivers/misc/khadas-mcu.c 的
  mcu_fan_auto_speed_percent）。驱动每 30 秒最多变化 5%，应用后需要几分钟才到新目标。
  MCU 风扇没有转速计，显示的是占空比，不是 RPM；不提供固定转速的手动模式。
- CPU、内存、温度、风扇与网络吞吐趋势每 5 秒采样，内存中保留 15 分钟，服务重启后清空。
  网络吞吐汇总有设备的物理网卡（有线、Wi-Fi、USB 网卡），不含 lo、dummy 与 Tailscale 隧道。
- 概览的「最近事件」同样只在内存中保留最近 60 条：每 5 秒对比 HDMI 信号与分辨率、USB 枚举、
  应用与板级服务状态、SoC 温度（85 °C 告警、回落到 80 °C 以下恢复），并记录面板内操作的结果。
  5 秒内来回变化的状态可能不被记录；在应用自身界面或命令行做的操作只表现为服务状态变化。
- 组件版本读自 /var/lib/dpkg/status 中已安装的 vim4-* 包，文件变化后才重新解析。
- HDMI 分辨率按接收器报告显示；YUV420 时接收器报告的水平像素数为一半，已换算。
