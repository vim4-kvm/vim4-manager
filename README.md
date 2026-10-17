# vim4-manager

VIM4 KVM 管理面板：选择开机启用的网页 KVM 界面（NanoKVM、JetKVM、One-KVM 或 PiKVM），
查看 HDMI、USB、温度等板子状态和底层服务，调节 EDID、HDR 映射与风扇曲线。
页面按侧边栏分为概览、KVM 界面、虚拟介质、视频输入、散热、网络、底层服务和更新（`#/cooling` 等哈希路由）。监听 **80** 端口，KVM 界面仍在 8080。

四个界面共用 HDMI 采集、硬件编码器、HID 端点和 8080 端口，同一时间只运行一个。
PiKVM 使用 vim4-pikvm.service；管理器会等待旧服务退出后
再启动另一个，避免端口和编码器仍被旧进程占用。

## 结构

更新页和概览的组件列表为 `.dev.N.g<提交号>[.dirty]` 版本显示「开发版」。
开发版只接收高于其基础正式版的后续正式更新，不将基础正式版误报为更新。

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

虚拟介质页（`#/media`）显示板级共享虚拟介质的文件名、只读/可写和 USB 连接状态，与当前应用无关；
KVM 界面页在有介质或状态未知时显示摘要和入口。
进入 PiKVM 或离开其介质配置时若磁盘仍挂载，可选择「弹出后继续切换」：当前会话保持
运行，在被控电脑安全弹出后，页面检测到空 LUN 才提交普通切换请求。特权助手再次核对
挂载状态，不提供强制弹出。等待仅属于当前页面，取消、离开、刷新、状态读取失败、
其他操作改变当前应用或超过 5 分钟都会取消；重新连接不会恢复旧等待。
`GET /api/status` 的 `media.known=false` 表示读取失败，不等于已经弹出。
浏览器回归：运行本地前端后执行 `node web/tests/media.mjs`（可设置 PLAYWRIGHT_MODULE）。

虚拟介质页提供按来源分组的已有镜像库、只读/可写挂载和两步确认弹出；等待弹出切换的提示留在 KVM 界面页。列表汇总 NanoKVM、JetKVM、
One-KVM、PiKVM 的 ISO/IMG 目录及所有共享数据盘。

数据盘页（`#/disks`）新建 FAT32 数据盘，在未挂载时上传、下载、新建文件夹、重命名和删除文件，
修改卷标、只读检查文件系统、下载完整镜像，以及扩容、创建/恢复快照、格式化和删除（需输入盘名确认）。
挂载到被控电脑时只能浏览和下载，列表可能落后于主机未写回的内容。
浏览器回归：`node web/tests/disks.mjs`。
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
所有路由校验 Host，带 Origin 的写请求须同源；Tailscale 来源禁止写入。
默认接受板子 IP、本机名及其 `.local` 名、localhost 和当前 MagicDNS 名；其他入口用
`-allowed-hosts name1,name2` 显式配置。这些检查不替代认证，局域网调用者仍能修改设置。

## Tailscale 组网

管理器统一管理整机 `tailscaled`，独立于当前 KVM 应用。助手提供
`tailscale-status`、`tailscale-install`、`tailscale-uninstall`、`tailscale-up`、
`tailscale-down`、`tailscale-login URL` 和 `tailscale-logout`。
安装使用官方签名 APT 源，只刷新该源；安装、卸载在独立 systemd 任务执行，
管理器重启不终止任务，与管理器更新共用包操作锁，不阻塞 KVM 切换。

`GET /api/tailscale` 返回守护进程、组网及最近任务状态；`POST /api/tailscale`
接受 `{action,controlURL,confirmed,previousControlURL}`，action 为 `install|uninstall|up|down|login|logout`。
只有 login 接受并要求 controlURL，可用官方服务器或 Headscale；返回 `{authURL}`。
其他操作返回 `{ok:true}`，安装、卸载的最终结果通过 GET 的 `job` 查询。

登录传入 `--accept-dns=false`；重连仅恢复 WantRunning，保留 Headscale 和其他设置。
断开、退出和卸载须 confirmed:true；切换控制服务器还须确认当前 previousControlURL。
状态由只读 LocalAPI 读取并缓存三秒，不返回对端公网端点；重复登录仅保留一个受管任务。
API 无认证，面向可信局域网；接入 tailnet 后，tailnet 内设备在访问策略允许时
也可访问管理面板 80 和 KVM 界面 8080 端口。状态字段、登录流程及验证见
[Tailscale 说明](docs/tailscale.md)。

## 共享数据盘 API

依赖板级包提供的 `/usr/lib/vim4-kvm/python/vim4media.py`、mtools 和 dosfstools。
应用包通过 `vim4-media-api-1` 声明共享模块依赖；升级前先安装新板级包，网页更新不会代装依赖。
数据盘位于 `/var/lib/vim4-kvm/usb/NAME.img`，名称为 1–64 个字母、数字、点、下划线或连字符
（首字符必须为字母或数字），再加 `.img`。已有 `disk.img` 保留原样。
新盘为 FAT32，64–32768 MiB，最多 8 个；预分配实际空间并保留至少 2 GiB 系统空间。
卷标为 1–11 个大写字母、数字、空格、下划线或连字符，两端空格会去除。

| HTTP | 参数与结果 |
|---|---|
| `GET /api/disks` | 返回 `name,size,mtime,label,freeBytes,attached,readOnly,editing,snapshots`；无法读取的卷标/空闲空间为 null |
| `POST /api/disks` | `{name,sizeMiB,label}` |
| `POST /api/disks/delete` | `{name,confirm,keepSnapshots}` |
| `POST /api/disks/format` | `{name,label,confirm,snapshot}`；可先快照，失败则不格式化，两步持同一数据盘锁 |
| `POST /api/disks/resize` | `{name,sizeMiB,confirm}`；仅扩容，先保留快照，复制和检查成功后替换镜像 |
| `POST /api/disks/label`、`/api/disks/check` | `{name,label}` / `{name}`；检查返回 `{ok,output}`（最多 16 KiB） |
| `GET /api/disks/files?disk=&path=` | 返回 `{path,stale,entries:[{name,dir,size,mtime}]}` |
| `GET /api/disks/file?disk=&path=` | 流式下载，RFC 5987 `filename*` |
| `PUT /api/disks/file?disk=&path=&overwrite=0或1` | 二进制请求体；必须有 `Content-Length`、`Content-Type: application/octet-stream` 和 `X-Vim4-Upload: 1` |
| `POST /api/disks/mkdir`、`/api/disks/rm` | `{disk,path}`；rm 递归删除 |
| `POST /api/disks/mv` | `{disk,from,to}`；仅同一文件夹内重命名 |
| `GET /api/disks/image?disk=` | 下载完整镜像，可写挂载时拒绝 |
| `POST /api/disks/snapshot` | `{disk}`，返回 `{id}` |
| `POST /api/disks/restore` | `{disk,id,confirm}` |
| `POST /api/disks/snapshot/delete` | `{disk,id}`，也可删除已保留的孤立快照 |

删除、格式化和恢复必须以完整盘名填写 `confirm`。文件路径为绝对 FAT 路径，深度不超过 16，
每段最多 255 字符，拒绝相对路径、空段、控制字符和 FAT 不支持的字符。
单文件最大 4 GiB-1；上传先写 root 私有临时文件，长度完整且空间充足才导入数据盘。
快照存于 `/var/lib/vim4-kvm/usb-snapshots/NAME/`，每盘最多 3 个，不自动淘汰；
删除数据盘默认同时删快照，`keepSnapshots:true` 可保留。重建同名盘后可恢复；恢复同时还原快照的容量。
扩容只支持无分区表的 FAT32 数据盘，先复制到新镜像并检查，再备份原盘、原子替换；
文件、卷标和旧盘快照保留。需要额外容纳新盘和旧盘快照的空间，最大 32 GiB。
所有时间字段为 Unix 秒；FAT 文件时间按 UTC 写入和解读，精度受 FAT 限制。
mtools 4.0.43 跨目录移动会丢失小写标记、目标不存在时崩溃，因此只提供重命名；
已有长文件名的条目改为全小写 8.3 名称时以大写保存（FAT 名称不区分大小写，内容不变）。

编辑前必须在被控电脑安全弹出（只读挂载也不允许编辑）。挂载中的盘允许浏览和文件下载，
`stale:true` 表示结果可能随主机写入改变。长操作只持该数据盘锁，不阻塞状态轮询、KVM 切换
或其他镜像挂载；编辑中的盘挂载立即失败。客户端断开会取消上传/下载助手。
上传取消发生在导入前不会修改镜像；导入、格式化中断不保证事务回滚，重要数据先快照。
快照完成后才发布，恢复和扩容准备完成后原子替换，准备阶段中断保留原盘。
强制结束进程可能遗留占空间的隐藏临时文件，但不会把未完成快照列为可恢复项目。
`GET /api/media` 继续返回所有数据盘（`source:"data",disk:true`）及各应用镜像。

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

真实 FAT 回归需在 Linux 安装 mtools、dosfstools 后运行同一 helper 测试命令；Mac 上这些测试会跳过。
工作区 VM 可用 `orb -m vim4-build bash -lc 'cd <工作区>/vim4-manager && python3 -m unittest discover -s deploy'`。

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
