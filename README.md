# vim4-manager

VIM4 KVM 管理面板：选择开机启用的网页 KVM 界面（NanoKVM、JetKVM、One-KVM 或 PiKVM），
查看 HDMI、USB、温度等板子状态和底层服务，调节 EDID、HDR 映射与风扇曲线。
页面按侧边栏分为概览、KVM 界面、虚拟介质、视频输入、HDMI 输出、散热、网络、底层服务和更新（`#/cooling` 等哈希路由）。管理面板监听 **80**，统一登录的 KVM 网关监听 **8080**。
网络存储页路由约定为 `#/storage`，使用下述 SMB/NFS 后端 API（前端另行实现）。

匹配的 5.15 / 7.x 共用完整管理器、应用数据和 8080 网关，公共启动器按内核选择硬件接口。
内核面板按已登记清单读取 release，支持 `7.3.0-vim4kvm-uhd1+` 并标记「正式版」；
rc7 仍可显示和切换，不显示正式版标记。可用性仍须通过清单的完整产物校验。
更新页的「内核」从 `/etc/vim4-kvm/kernels.json` 列出已登记内核；
`GET /api/kernel` 读取状态，`POST /api/kernel` 接受 `{id: "vendor"|"mainline", reboot: boolean}`。
限定助手核对启动参数、Image、DTB 和模块哈希，保存默认项，重启前拒绝挂载中的虚拟盘并停止应用。
切换需要重启；启动失败时仍需串口或 OOWOW 恢复，不提供自动失败回退。
未安装双内核清单时不显示可切换项。板级依赖为 `vim4-runtime-api-1`。

概览在开机时长左侧显示本次开机的 PD 协商电压、电流与供电额度。
API 中的实时电压存在检测依赖板级 `usb-pd-init --status`，按 AO-A 控制器识别 I²C 总线，
兼容 5.15 的 6 与 7.x 的 1；旧版本或读取失败为未知。
支持读取 `/proc/device-tree/chosen/khadas,usb-pd-boot` 的 v1 启动固件快照，
`power.firmwarePD` 独立保留 PS_RDY、原始 PDO/RDO、规范版本、Rp 和失败/硬复位标记。
来源能力列表展示额定值，合同额度按实际 RDO 最大请求解析，同时保留工作请求；不直接使用 PDO 电流上限。
`bootContract`（Linux 初始化）优先展示，固件记录在来源能力内并列保留。
旧 U-Boot 缺少属性时保持原显示。7.x 没有 Linux TCPM；板级开机服务仅在固件
PS_RDY 合同缺少 USB comm 位时做一次 USB-capable 5V 协商，其完成日志同样优先展示。
协商额度取当前 systemd 初始化实例的完成日志，不代表运行期间的实时合约。
`GET /api/status` 的 `power.vbusPresent` 与 `power.bootContract` 可分别为 null。
板级 `vim4pd.py` 在本次合同确认后原子保存 `/var/lib/vim4-kvm/pd-last-contract.json`，
Linux 初始化结果覆盖更早的固件合同。`power.lastContract` 仅提供其他 bootId 的完整历史记录，
不把历史记录当作实时检测。同次启动优先显示 Linux、固件合同；固件超时、没有收到 PDO
且 VBUS 存在时，主值按「5V 3A · 沿用」显示额度，detail 保留板端本地时间；
无记录时主值为「仅 Type-C」，detail 为「本次未重新协商 · Rp …」。
≤400px 时 PD 与开机时长各占整行，保留其他状态的完整主值。空图只显示一条占位文案。
安装此版 helper 前必须先安装配套板级 `vim4pd.py`，安装过程不重启 PD 服务。
读取最多每 5 秒一次，失败清除旧读数。当前不测实际电流、功耗或 USB-C/VIN 供电分担。

趋势图的「CPU 动态功耗（估算）」复用 5 秒采样和 15 分钟内存历史。
限定助手 `cpu-power-snapshot` 读取内核 Energy Model（必须标记 milliWatts 或 microWatts）、
各频率 time_in_state 和各核 /proc/stat。每个 CPU 簇按区间频率驻留加权模型功率，
乘以各核忙碌比例之和，再汇总成瓦数。频率与负载的区间内相关性未知，因此只是
动态功耗近似，不含漏电、GPU、编码器、内存或供电损耗，未经仪表校准。
未注册 Energy Model 时，读取设备树 `dynamic-power-coefficient` 和 debugfs 中经过
速度分档调整的实际 OPP 电压，按内核的 C×V²×f 模型计算各频率功率，不使用额定电压代替。
模型或计数器缺失时 `history[].cpuPowerAvailable=false`，网页显示「暂无法估算」。
`history[].cpuPowerW` 为 null 表示缺失、计数器重置或模型/在线核变化；
恢复后需要两次连续有效采样，图表缺口不连线。零值仅代表估算的动态功耗为零。
浏览器回归：`node web/tests/power.mjs`（本地前端默认 5188，可用 TEST_URL 覆盖）。

四个界面共用 HDMI 采集、硬件编码器、HID 端点和回环后端 8081 端口，同一时间只运行一个。
PiKVM 使用 vim4-pikvm.service；管理器会等待旧服务退出后
再启动另一个，避免端口和编码器仍被旧进程占用。
应用需配套升级为回环 8081 监听并关闭网页登录。旧应用仍占 8080 时，管理器继续提供 80，
每 2 秒重试绑定网关，支持任意升级顺序。参数 `-kvm-listen` 默认 `:8080`，
`-kvm-backend` 默认 `127.0.0.1:8081`；MCP 白名单、断连及 SSH 应急转发见 [账户说明](docs/auth.md#kvm-网关)。

## 结构

`GET /api/status` 的 `encoder` 提供 Wave5 内核隔离告警：`known` 区分旧内核或
读取失败，`isolated`、`needsReboot` 表示必须重启，`reason` 保留内核原因，
`timeBoottimeNs` 是十进制字符串，按本次启动的 CLOCK_BOOTTIME 纳秒计时。
前端告警另行实现；此接口不触发自动重启。

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
- Wi-Fi：`wifi on|off`、`wifi-status`、`wifi-scan`、`wifi-connect`、`wifi-activate`、
  `wifi-disconnect`、`wifi-forget`、`wifi-autoconnect`、`wifi-hotspot`、`wifi-mode`。
  网络页管理客户端与 WPA2 热点；密码通过助手标准输入传递，以 0600 keyfile 保存。
  状态与扫描不占写操作锁，模式切换和连接失败会尝试恢复无线入口。API 与回退规则见
  [Wi-Fi 说明](docs/wifi.md)。

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

管理器 API 需要管理员登录，首次设置、会话有效期与密码重置见 [账户说明](docs/auth.md)。
POST 只接受 application/json，所有路由校验 Host，带 Origin 的写请求须同源。
默认接受板子 IP、本机名及其 `.local` 名、localhost 和当前 MagicDNS 名；其他入口用
`-allowed-hosts name1,name2` 显式配置。登录后局域网与 Tailscale 来源均可修改设置。

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
管理器 API 需要管理员会话；接入 tailnet 后，tailnet 内设备在访问策略允许时
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

## 网络存储 API

管理器包依赖 `cifs-utils`、`nfs-common`，提供虚拟能力 `vim4-nas-api-1`，供后续
One-KVM 等包声明依赖。文件夹虚拟 U 盘见下方「NAS 文件夹 U 盘」；录制目标另行实现。
最多 8 个存储，创建时从名称加随机后缀生成 `[a-z0-9][a-z0-9-]{0,31}` ID；创建后 ID、类型不可改。

稳定的板上接口：helper 按需创建 root:root 0755 的 `/etc/vim4-kvm/nas/` 和
`/var/lib/vim4-kvm/nas/`。每个 `ID.json` 为 root:root 0644，仅含
`id,name,type,server,share,domain,username,version,autoMount`，无密码；SMB 的 `ID.cred`
为 root:root 0600，内容为 mount.cifs 的 `username=`、`password=`、`domain=` 三行。
文件原子替换。包卸载不删除这些用户配置或 NAS 数据。
挂载点固定为 `/var/lib/vim4-kvm/nas/ID`；单元名由
`systemd-escape --path --suffix=mount` 生成，单元在 `/etc/systemd/system/`。
`autoMount:true` 启用单元（`WantedBy=remote-fs.target`）；禁用自动挂载不表示立即卸载。
其他程序必须查 `/proc/self/mountinfo` 或比较挂载点与父目录 `st_dev` 判断已挂载，不能只看目录存在。

| HTTP | 参数与结果 |
|---|---|
| `GET /api/storage` | `{known,tools:{smb,nfs},storages:[…]}`；helper 失败时 `known:false` |
| `POST /api/storage/test` | `{id?,type,server,share,domain,username,password?,version}` → `{ok,totalBytes,freeBytes,writable,elapsedMs,error}` |
| `POST /api/storage` | `{id?,name,type,server,share,domain,username,password?,version,autoMount}` → 保存后的存储对象 |
| `POST /api/storage/mount`、`/api/storage/unmount` | `{id}` → 操作后的存储对象 |
| `POST /api/storage/delete` | `{id,confirm}`，confirm 必须等于完整存储名称 → `{ok:true}` |
| `GET /api/storage/dirs?id=&path=` | 挂载内绝对路径（根为 `/`）→ `{path,entries:[{name}],truncated}` |
| `POST /api/storage/mkdir` | `{id,path,name}` → `{path:新目录完整相对路径}`（以 `/` 开头） |

存储对象含全部非敏感配置及 `mounted,state,error,path,totalBytes,freeBytes,stale,writable,busy,insecure`。
`state` 为 mounted/unmounted/mounting/error；`error` 使用 systemd 最近失败的 Result 原因。
只在实际挂载后探测容量，子进程 2 秒超时则 `stale:true`、容量为 null。
`writable` 为最近一次测试或挂载后以 khadas 身份创建、写入、删除隐藏文件的结果，未检测或超时为 null；
运行时结果保存在 `/run/vim4-manager-nas/`，重启后清空。`busy` 尽力检查进程 fd/cwd/root/maps 和 USB LUN，
检测失败为 null；卸载时无法确认空闲也拒绝操作，最终仍由普通 systemd stop/umount 检查占用，不提供强制或 lazy 卸载。
目录读取用 openat/O_NOFOLLOW 逐级打开，拒绝符号链接、`.`、`..`、空段、控制字符和反斜杠；
深度最多 32，最多返回 500 个子目录，返回项按名称排序，3 秒超时。
新建目录同样逐级 openat/O_NOFOLLOW、3 秒子进程预算；name 使用共享名的单段规则，
UTF-8 最多 255 字节，禁止 `.vim4-nasdisk`，mkdirat 模式 0770（SMB 权限由挂载参数决定）。
同名目录或文件返回「已有同名文件夹」。

SMB share 为共享名，可附子路径 `share/sub/dir`；NFS share 必须为 `/export/path`。
server 只接受主机名、IPv4、IPv6（裸 IPv6 输入，源地址自动加方括号，不支持 zone ID）。
共享路径段可含中文和空格（NAS 常用），拒绝空段、`.`、`..`、首尾空白、控制字符、反斜杠及 `"*?<>|:%`；
`%` 会被 systemd 当作插值，`What=` 中空格按原样写入（`\x20` 不会被反转义）。用户名/域同样允许中文和空格，
拒绝控制字符、首尾空白与 `\/"[]:;|=,+*?<>%`。
密码禁止 CR/LF/NUL；新 SMB 配置必须提供 password，可为空，编辑或测试已有 ID 时省略则沿用保存值。
密码只经请求体和 helper stdin 传递，不进入命令行、配置 JSON、日志或返回值。

SMB 固定选项为 `credentials=…,uid=khadas,gid=khadas,forceuid,forcegid,file_mode=0660,dir_mode=0770,soft,echo_interval=10,serverino,iocharset=utf8,nofail,_netdev,x-systemd.mount-timeout=30`；用户名为空时以 `guest` 代替凭据文件。
板子内核默认 NLS 为 iso8859-1，缺少 `iocharset=utf8` 时中文共享名无法挂载（error 2），中文文件名也会错乱。
测试挂载不带 `nofail/_netdev/x-systemd.*`：带 `nofail` 时 mount 失败也返回 0，会掩盖真实原因。
version 默认 auto（不传 vers），其他只允许 3.1.1/3.0/2.1/2.0/1.0；1.0 返回 `insecure:true`。
NFS 固定 `soft,timeo=150,retrans=3,nofail,_netdev,x-systemd.mount-timeout=30`，版本 auto 或 4.2/4.1/4.0/3，
非 auto 传 nfsvers。NFS 属主由服务器决定，`ok:true,writable:false` 表示挂载可读但 khadas 不可写。
soft 挂载在网络故障时可能返回 I/O 错误，调用方需处理失败，不能把挂载存在等同于可写。
SMB 在 NAS 无响应约 30 秒后报错；NFSv4/TCP 在服务器静默丢包时，实测 `timeo=50,retrans=2` 下写入和 stat 仍阻塞超过 300 秒，
挂载参数无法给出上限。所有读写 NAS 的程序必须自行设上限（管理器 2–3 秒子进程、One-KVM 录制 1.5 秒等待）；
NAS 文件夹 U 盘为主机读写另设 8 秒上限，NAS 卡住时向被控电脑返回 I/O 错误。

测试临时挂载在 `/run/vim4-manager-nas-test/随机/mount`，挂载、探测、卸载预算分别为 8/3/3 秒，
正常 15 秒内返回。内核不可中断 I/O 的工作进程可能在返回后等待 NAS 恢复；清理失败会明确返回失败，
保留挂载目录供管理员检查，删除临时凭据，不递归删除目录。强制结束助手也可能留下临时挂载或隐藏探测文件。
保存会停止旧单元、原子更新配置/凭据/单元、daemon-reload、enable/disable；原先已挂载或 autoMount 为真则启动。
启动失败仍保留新配置，之后可重试挂载；多文件更新不保证断电事务回滚。
manager 的 ExecStartPre 调用 `storage-migrate`，按当前模板更新内容有变化的单元并 daemon-reload，
让升级前的存储也获得 `iocharset=utf8`。已挂载且空闲时重启单元；忙或无法确认空闲时保留当前挂载，
输出原因，新参数下次启动生效。每存储最多约 5 秒、总预算约 20 秒，不等待失联 NAS。
状态与目录读取不占写锁，其余操作共用独立 storage 锁。接口沿用局域网 Host、JSON、同源与禁止 Tailscale 写入边界，无独立认证。
manager 仍以 khadas 运行，root helper 执行挂载；service 无需增加 ReadWritePaths，也不能加入隔离挂载命名空间。

离线验证：`go test ./...`、`go vet ./...`、`python3 -m unittest discover -s deploy -p 'test_*.py'`。
板上由操作者使用 `sudo /usr/libexec/vim4-manager-helper storage-list`、
`findmnt /var/lib/vim4-kvm/nas/ID` 和 `systemctl status "$(systemd-escape --path --suffix=mount /var/lib/vim4-kvm/nas/ID)"`
核对状态；真实 NAS 凭据通过 API 请求体输入，不写进命令行。需另验证 SMB/NFS 挂载、重启自动挂载、
khadas 写权限、USB LUN 占用拒绝、断网超时/恢复及临时挂载清理。

## NAS 文件夹 U 盘

选择已连接存储中的目录（`/` 表示根目录），以只读或可写模式连接被控电脑。
守护进程扫描快照，通过 `internal/vfat` 合成 FAT32，再由 FUSE 暴露普通镜像文件。
同一时间只有一个会话，已有介质时拒绝替换；JetKVM 只允许只读。
卷标最多 11 个大写字母、数字、空格、下划线或连字符；省略时过滤目录名，结果为空用 `NAS`。
FAT 时间是不带时区的本地时间，时区取自发起挂载的浏览器：前端传
`utcOffsetMinutes=-new Date().getTimezoneOffset()`，范围为整数 −720…840；
缺省使用板子当前本地时区偏移。会话固定该偏移，不随夏令时或另一浏览器改变；
偏移持久化到会话配置和 snapshot，恢复回写也使用原偏移。旧会话缺省为 0（UTC），保持原行为。

只读模式不创建写入层。可写模式的空闲余量为 `min(NAS 可用空间 − 2 GiB, 64 GiB)`，
不足 256 MiB 时拒绝；最终容量还包含 FAT 元数据和簇对齐。
主机写入保存到所选目录的 `.vim4-nasdisk/SESSION/overlay` 和 `.index`，挂载期间不修改原文件。
扫描排除 `.vim4-nasdisk`；FAT 非法名称、特殊文件、超过 4 GiB−1 的文件等列为跳过项，
状态最多展示 100 条并保留总数。跳过项不进入 U 盘，也不会因其在卷中不存在而删除。

被控电脑安全弹出或管理器完成现有弹出操作后，守护进程每秒核对 LUN，FUSE Release 也触发检查。
停止写入后解析最终卷：完整且无警告时自动回写；否则进入 `needs-decision`。
可以重新挂载同一写入层让电脑修复、显式选择回写可识别内容，或以会话 ID 确认放弃。
部分解析结果的恢复只导入已识别内容，不据不完整目录列表执行删除。
只读弹出直接结束。单纯卸载主机卷可能尚未清空 LUN，需要主机真正执行安全弹出。

回写先检查原路径前置条件并保存写入内容，再执行持久化 journal。
外部修改的原文件保留，主机内容使用带 UTC 时间的冲突副本名；其他项继续执行。
删除冲突保留 NAS 原项并记录冲突，此时 `copy` 为空（主机已删除该项，没有可导出的内容）。
被覆盖、删除的原文件进入 `.vim4-nasdisk/trash/SESSION/原相对路径`，不自动清理。
新内容通过同目录独占临时文件、fsync、rename 发布并设置 mtime。
恢复按 journal 判断已完成步骤；SIGTERM 在当前步骤完成并保存进度后退出。
完成或放弃后删除写入层、journal、暂存内容和该会话目录，保留 trash。

新会话采用布局版本 2：簇大小至少 4 KiB，每份 FAT 长度及起点按 4 KiB 对齐，
通过增加保留扇区使数据区起点按簇大小对齐，FSInfo 与备份引导位置不变。
这样 4 KiB 写入层块不会跨簇，`DirtyClusters` 的保守判断仅影响同一簇内，
目录改名或文件原地修改不会让相邻未改动文件被误判为改写、产生无谓复制和 trash。
`snapshot.json` 的 `Options.LayoutVersion` 保存布局版本；缺省按旧版本 1 恢复，
精确重建旧几何参数和 overlay 布局 ID。旧 pending 会话可继续回写，仍受旧布局
跨簇脏标记的限制；新规则只用于新会话，不改动已有写入层。

重启或崩溃后，已挂载存储下含写入层或 journal 的会话列入 `pending`，可以回写或放弃。
恢复模式不挂 LUN；之前崩溃遗留的 LUN 必须先弹出。状态查询中的服务探测、pending 扫描和
trash 统计共享约 3 秒预算，扫描另有条目上限。
pending 扫描超时返回 `known:false`，不能据空 pending 列表判断没有待恢复数据。
服务持有 NAS 目录描述符和写入层文件；网络存储 busy 检查还检查正在运行的会话，防止扫描启动窗口内卸载。

| HTTP | 参数与结果 |
|---|---|
| `GET /api/nasdisk` | `{known,session,last,pending}`；session 为当前状态，last 为最后结果 |
| `POST /api/nasdisk/start` | `{storage,path,mode:"ro"或"rw",label?,utcOffsetMinutes?}` → `{ok,id}`，扫描异步进行 |
| `POST /api/nasdisk/cancel` | `{}`；scanning/attaching 可取消，attached 需先安全弹出 |
| `POST /api/nasdisk/commit` | `{id,force?:true}`；强制恢复必须显式指定 force |
| `POST /api/nasdisk/reattach` | `{id}`；仅当前尚未开始回写的会话 |
| `POST /api/nasdisk/discard` | `{id,confirm:id}` |
| `POST /api/nasdisk/trash-empty` | `{id:last.id,confirm:last.id}` → `{ok:true,trash:{bytes:0,files:0}}`；有运行中的会话时拒绝 |

session 包含存储、路径、模式、卷标、扫描计数、文件/目录数、容量、已用/写入字节数、
跳过项、USB configured 状态、计划计数、步骤/字节进度、决策原因和错误。
`session.utcOffsetMinutes` 为固定时区偏移；`decision.reason` 和 failed 的 `error` 为中文可读原因。
`session.nasStalled` 表示最近 10 秒内发生过 I/O 超时，可提示「NAS 暂时无响应，电脑上的读取会失败」；
没有新超时后自动清除。状态发布读取缓存的写入量，不等待 NAS 或写入层互斥锁。
`session.detail` 保留原始错误或 FAT 警告（通常为英文，供前端折叠排查），恢复正常状态后清空。
源读取失败会携带所选目录内以 `/` 开头的文件路径，如「读取 NAS 上的 /工具/random.bin 失败：文件在 U 盘挂载期间被改动，或 NAS 暂时无法访问」。
状态为 `scanning/attaching/attached/parsing/committing/needs-decision/failed`。
last 包含 storage ID、path、结果、计数、冲突副本位置、结束时间和 `trash:null或{bytes,files}`。
`last.detail` 和 `last.utcOffsetMinutes` 分别保留失败原文和会话偏移。
trash 为该文件夹 `.vim4-nasdisk/trash` 中全部历史会话的普通文件逻辑字节数与文件数；
未挂载、旧记录缺 storage/path、读取失败或超过 3 秒预算时为 null。
清空仅作用于 last 指向的文件夹，逐级 O_NOFOLLOW、不跟随符号链接、不进入其他挂载，3 秒预算；
超时可已删除部分内容，重新读取状态后重试。pending 包含存储、路径、写入量、开始时间、`utcOffsetMinutes` 和 journal 标记。
接口沿用现有 Host、JSON、同源和禁止 Tailscale 写入边界。
`media.nasdisk` 提供 `{storage,storageName,path,mode}`，介质名称为 `nas:存储名称/路径`；弹出 API 不变。

板上安装 `/usr/libexec/vim4-nasdisk` 与 root 的 `vim4-nasdisk.service`，依赖 fuse3。
运行目录 `/run/vim4-nasdisk/` 为 0755，包含 helper 写入的 `session.json`、每秒更新的
`status.json`、`last.json`、0600 的 `control.sock` 和 FUSE 挂载点 `fs/`。
镜像名为 `disk-SESSION.img`；socket 接受 JSON `status/commit/discard/reattach/cancel` 请求。
FUSE 请求解析失败一律回复错误；Android GKI 的 `FUSE_CANONICAL_PATH=2016` 回复 ENOSYS，
不返回空成功或路径，避免内核越界及递归 LOOKUP 自锁。go-fuse v2.12.0 起上游已如此处理
（v2.8.0 解析失败不回复，请求永久挂起），升级依赖时保持这一行为。
创建镜像（含 INIT/WaitMount）的总预算为 15 秒，超时进入 failed，显示「无法创建 U 盘镜像（FUSE 无响应）」。
取消/停止可中止等待；卸载无响应时按 mountinfo 的设备 minor 写 fusectl `abort` 后 lazy unmount，
释放内核等待者再退出。守护进程启动及 helper 启动会话前同样清理遗留 fs/ 挂载，不 stat 失效挂载点。
LUN 连接必须由 helper 的 `nasdisk-lun-attach SESSION` 持共享介质锁调用 `attach_media()`；
它保留现有端点预算与 UDC 重绑规则。其他固定操作为 `nasdisk-status/start/cancel/commit/reattach/discard/trash-empty`。

限制：FAT32 单文件最大 4 GiB−1；文件时间使用会话固定时区偏移，FAT 精度为两秒。
源读取前后均核对 size、纳秒 mtime 与普通文件类型；首次不一致丢弃本次读取，关闭描述符后
异步等待 1.1 秒，再 openat+fstat 复核一次。等待期间该文件返回 EIO，不持锁阻塞其他文件；
复核符合快照后允许后续读取，复核仍不一致才永久拒读。open/stat 的暂时错误返回 EIO，但不永久判定修改。
每次不一致和 open 失败在 journal 记录 SourceID、读前/读后阶段、期望/实际 size、mtime 纳秒、mode、errno；
复核结果也记录。可用 `journalctl -u vim4-nasdisk.service` 排查。读取始终不接受已知不一致的数据，
但属性检查不能识别保持相同 size/mtime/类型的内容替换，不能替代两端互斥编辑。
未进入写入层的旧字节无法凭空恢复，
回写读取因此失败时保留会话。请避免两端同时编辑。结构校验不能证明主机已刷出全部缓存，仍须安全弹出。
SMB 的 `actimeo` 默认属性缓存为 1 秒；1.1 秒复核仅针对这一默认值，显式增大 `actimeo` 不在此保证内。
Linux CIFS 的 `cifs_inode_needs_reval` 按缓存期限、缓存权限等决定属性复核，因此 rename/utimens 后的
扫描与随后 open/fstat 有可能观察到不同时刻的属性（推断，不是本次实测根因）。
旧布局现场记录只能证明 EIO 与快照属性不符后永久拒读的路径相容；事后 stat 相同无法确定当时差异。
尚无证据证明 serverino 复用、Samba close 更新写时间或 utimens 缓存中的哪一项触发了现场问题。
源校验不比较 inode/serverino，编号复用本身不会直接触发拒读，除非它间接影响了所见属性。
OrbStack vim4-build 无 cifs-utils/Samba，回归使用本地目录复现临时名写入、fsync、rename、设置 mtime 后立即扫描读取，
并用受控 mtime 变化覆盖瞬时不一致恢复、真实修改永久 EIO；不能当作 SMB 断线重连验证。
每个写入块均同步到 NAS，速度受网络往返影响。回写暂存内容和临时文件需要额外空间，空间不足保留会话供恢复。
单个 FUSE 读、写及 fsync（包括等待写入层串行门）超过 8 秒返回 EIO，
低于 macOS/Windows/Linux 常见的 30 秒 SCSI 命令超时，为 f_mass_storage 和主机重试留余量。
预期主机表现为读写报错、f_mass_storage 报告介质错误，避免因 NAS 长时间无响应而复位整个 USB 设备；
实际主机的重试和复位策略仍需实板验证。超时不表示源文件被修改，不改变上述快照复核规则。
已进入 NAS 系统调用的操作可能稍后完成；每会话最多保留 4 个后台操作，满额立即 EIO。
可写卷的串行门一直保留至实际操作结束，后续请求在自己的截止时间内放弃，不留下迟到写入队列；
因此早先卡住的写不会覆盖后来成功的版本。读写使用独立缓冲区，超时后不再访问主机请求内存。
写入或同步超时后，即使主机已收到失败，写入层也可能稍后记录成功的版本；主机可能重试或将文件系统标脏，
Parse 会继续检查结构，但结构正确不能证明主机意图。会话保留写超时标记，弹出后强制进入 `needs-decision`，
原因是「NAS 在 U 盘写入期间暂时无响应」，不自动回写。NAS 恢复后可重新挂载检查，
或显式选择回写可识别内容、放弃；重新挂载不清除该会话的写超时标记。
SMB/NFS 恢复、真实 USB eject 和电源中断仍需实板验证。

Go 依赖固定在 `go.mod/go.sum`，同时提交 vendor，Go 构建无需下载模块。
Linux VM 验证可交叉编译 `go test -c ./internal/nasdisk`，在具有 `/dev/fuse`、dosfstools、mtools 的 VM
运行测试二进制；FUSE 测试覆盖 fsck、主机文件操作、解析、回写与 trash，不使用真实 USB LUN。

## HDMI 输出

`#/output` 提供透传和声音开关，每 2 秒读取 `GET /api/passthrough`，操作期间及离页停止轮询。
`POST /api/passthrough` 接受可选的 `enabled`、`audio` 布尔值，至少提供一项，返回实际状态。
偏好沿用管理器 `-state-dir`（默认 `/var/lib/vim4-manager`），原子保存到 `passthrough.json`，
声音默认关闭；支持的 provider 在管理器启动时恢复设置。操作失败不保存新偏好，保存失败尝试恢复旧设置。
`/api/status` 同时提供 `passthrough` 摘要供其他页面的导航提示使用。

`passthrough-5.15` 分支通过限定助手接入厂商 VFM TEE：`vdin0 vfm_cap amvideo`。
能力探测同时要求 5.15、精确路由、sysfs 和 root 管理的
`/etc/vim4-kvm/passthrough-5.15.json`（`abi:1`、`release`、`moduleNoteSha256`）。
验证新内核时可使用 `{"abi":1,"kernels":[{"release":"…","moduleNoteSha256":"…"},…]}`，
同时保留旧、新内核资格；每条仍须同时匹配运行 release 与 aml_media note SHA256。
更新前备份原记录；此元数据不改变透传声音偏好、路由或 EDID。
最后一项为运行模块 `/sys/module/aml_media/notes/.note.gnu.build-id` 的 SHA-256，
只在已验证 VDIN `VFRAME_FLAG_VIDEO_LINEAR` 补丁的模块上登记，不能仅凭内核版本宣称支持。
未通过探测时 GET 返回 `supported:false,state:"unsupported",enabled:false`、POST 返回 409，保留偏好。
板级 HDMI 服务单独读取 `/etc/default/vim4-kvm-passthrough` 的 `HDMI_DISPLAY_TEE=1`；
`vim4-passthrough prepare` 在 HDMI 源启动前核验模块并建立 TEE，未通过时保留独立采集。
这不会改动 KVM 的采集尺寸、格式、游戏模式或源 EDID，也不会增加第二个 VDIN 所有者。

`vim4-passthrough.service` 独立于浏览器跟随逐行 SDR 输入和 OUT HPD，取输入与显示器模式交集，
首选 1:1、否则明确 `scaled`，只用 sink 声明的 YCbCr444 8-bit，不走有已知误差的 RGB。
实际输出模式、格式、帧率读回和显示计数推进后才报告 `running`；不依赖静止像素判断失锁。
关闭透传只隐藏 VD1、恢复 OSD，保留 TEE 消费及 KVM；HDMI 服务重启后自动重新探测。
支持普通/1000:1001 刷新率的 720p/1080p/2160p 已枚举模式，隔行和其他刷新率明确拒绝。
HDR10/HLG 只有在运行驱动的 `/sys/class/vdin/vdin0/hdr_sdr` 确认已做硬件映射时才显示，
此时仍输出 SDR、`output.hdrToSdr=true`；即便显示器支持 HDR，也不能把已经映射过的
8-bit SDR 帧重新标为原生 HDR。原生 10-bit HDR 显示须另有独立的采集/显示路径。
厂商 `SMPTE_ST_2048` 拼写归一为 HDR10（PQ）；Dolby Vision 明确不支持。
`unsupported-format` 和 `video-error` 保留真实 `input/monitor`，用 `reason` 说明原因，
不把有锁定但暂不可显示的输入误报为 `no-signal`；声音在这两种状态下可独立继续。
声音由独立的 `vim4-passthrough-audio.service` 跟随视频与接收器状态，不参与 HDMI modeset。
厂商接口未暴露可用的 RX→TX 直接硬件回环，因此使用单进程 libasound PCM 桥：
`FRHDMIRX → EXTN hw:CARD=AMLAUGESOUND,DEV=6 → SPDIF DEV=1 → HDMITX`。
它不打开 One-KVM 的 TDM-B `DEV=0`、不使用 arecord/aplay 管道，不改 KVM 采集参数。
依赖 `python3`、`libasound2`、`alsa-utils`；安装时须同时复制音频 Python 模块和两个服务单元。
仅支持立体声 PCM 44.1/48kHz，输出为 16-bit；多声道、AC3 等压缩流、其他采样率或
显示器未声明相应 PCM 能力时停止本地声音，视频继续，声音偏好仍保留。
`audio` 表示保存的开关，`audioState` 表示实际的 `off/starting/waiting/running/unavailable/error`。
进程/PCM 异常有界退避重试；状态查询只读，音频失败不会重启视频服务。
周期 256 帧、缓冲 2048 帧；48kHz 实测 ALSA 队列约 26.7ms，44.1kHz 约 29ms，
不包含接收器/显示器延迟，不能当作扬声器端 A/V 同步实测。
EXTN 的初始无效输入选择 0 只初始化一次为 FRHDMIRX 8，之后保留；其他已配置输入不抢占。
拿到两个独占 PCM 后才修改输出路由；仅当 ASRC 属于 FRHDMIRX 时旁路它，不改 KVM 的
TDMIN_B 重采样。原路由保存在 `/run/vim4-passthrough/audio-before.json`，停止或异常退出后
在仍持有两个端点时比较并恢复；其他程序占用时不强行复原或覆盖其更改。
底层命令错误只记 journal，API 返回已有中文提示，不把 sudo/ALSA 路径直接显示给用户。
异常请求回退旧设置；控制进程无响应或状态过期不伪造成功。
模式跟随对 RX 刷新率取七次采样中值、使用 0.005Hz 的半频点滞回，并要求新模式稳定两秒；
59.97–59.99Hz 的测量抖动不再被当成 59.94/60Hz 模式切换。
TX 的模式别名、颜色空白/后缀及数值读回会规范化；ready 短暂下降先防抖，
读回异常仅报告状态，不触发同一模式反复重设。只有实际输入模式或 sink 变化才允许一批 modeset，
失败也不循环重试。status 只读，唯一硬件模式写入者为持有独占 flock 的 watch 服务；
每批真正重设将原因、原始读回及不匹配项写入 journal。
HDMI OUT 热插拔同时监听内核 `hdmitx_hpd` uevent 和 HPD 读回，重新确认 sink/EDID 后
恢复模式，避免短脉冲漏采及驱动稍后回退 RGB 的竞态。透传期间使用厂商 DRM
`osd0/blank`、`osd1/blank` 持久策略隐藏控制台，而非只缓存一次 fb blank；
原策略保存在 `/run/vim4-passthrough/osd-before.json`，关闭时恢复，服务重启不丢失。
热插拔期间无效 EDID、暂时缺失的 sysfs 及错误清理失败不会退出 watch 或解除 OSD 屏蔽。
API 用 `input`、`monitor` 对象是否存在表示有输入信号、显示器已连接；无此对象时前端不推测参数。

浏览器回归：`node web/tests/passthrough.mjs`，沿用 `PLAYWRIGHT_MODULE` 和 `TEST_URL`；
默认在 `/tmp/codex-ui/passthrough-*.png` 输出桌面/手机、浅色/深色的 40 张状态截图。

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

前端开发：`pnpm --dir web dev`，管理 API 和 `/__vim4/api` 默认代理到本机
http://127.0.0.1:5189（可用 VIM4_MANAGER 覆盖）；登录页面与资源由 Vite 提供。

## 已知限制

更新页从各应用的公开 GitHub Release 查询版本。NanoKVM、JetKVM、One-KVM
使用自己的设置页安装；PiKVM 和管理面板可以直接在管理器中更新。
下载经过大小和 SHA256 校验，特权助手再验证包名、ARM64 架构和递增版本，
拒绝会修改其他包的 APT 安装计划。PiKVM 挂载虚拟介质时必须先安全弹出。
更新只重启正在运行的目标服务，不切换当前 KVM 应用；管理器更新后需刷新网页。
发布清单固定为各仓库的 `<package>-latest.json`，下载目录由 systemd 创建在
`/var/lib/vim4-manager/updates`。该功能需要管理员登录。

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
