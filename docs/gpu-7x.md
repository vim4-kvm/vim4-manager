# 7.x GPU 利用率接入与 kbase 合入说明

本轮只离线分析和修改 manager；板锁 `/tmp/vim4-board.lock`、`/tmp/vim4-heavy.lock`
被其他会话持有，因此没有 SSH、部署、刷机、重启、HID 或声音操作，没有采集真实 5.15 fixture。
manager 基线为 `0c89b29`，已有 Panfrost 原生 helper，不重复替换它。

## 5.15 源码合同

只读核对 VM `~/src/linux@80a07ad5406d57855c996285ae75a50a1b9147ae`（干净）。
当前 `common_drivers` 子仓库未包含该实现；实际来源是主内核
`drivers/gpu/arm/midgard/` 下 r44p0 的厂商 T7 平台层：

- `platform/devicetree/mpgpu.c:238` 的 utilization_read 输出十进制整数加换行，
  从 mpgpu_get_utilization 读取缓存，不在读取时重新采样或清零。
- `platform/devicetree/meson_main2.c:74` 的静态 last_utilisation 初始为 0，
  每次 kbase_platform_dvfs_event 更新；导出的是 0–100，回调传给其他组件的
  `utilisation*255/100` 不影响此接口。util_gl/util_cl 是工作类型份额，不能代替总利用率。
- `backend/gpu/mali_kbase_pm_metrics.c:400`：整数截断
  `100 * delta_busy / max(delta_busy + delta_idle, 1)`。
  gpu_active 为真时累计 busy，否则累计 idle；这是 GPU 至少有工作时的时间比例，
  不按频率加权，不包含视频编码器，也不累加各引擎重叠时间。
- PM 累计计数为 u32、单位 256 ns；每次 DVFS action 与自己上次快照相减。
  `mali_kbase_config_defaults.h:95` 默认 dvfs_period=100 ms，
  `device/mali_kbase_device.c:295` 初始化，metrics 的 hrtimer 以此周期更新。
  可经驱动 dvfs_period 配置改变，实际板端设置本轮未读。
  稳定空闲且计时运行时值为 0；初始为 0。计时停用时接口保留最后缓存，不能保证立即归零。

manager 每 5 秒读取一次缓存，接受 0–100 的整数；文件存在但值无效返回 null。
所以它显示最近 DVFS 窗口，而非过去 5 秒均值。API 保持 `history[].gpu` 数值百分比或
null，0 是有效空闲；缺失留缺口，不新增前端字段或模拟值。

## 后端与时间窗口

探测每次重新执行，不缓存“不支持”：

1. mpgpu：同 5.15，文件存在但无效不降级。此路径不调用 GPU helper。
2. kbase：现有固定 sudo 入口 `gpu-snapshot` 发现 `drivers/mali/*.gpu`，读取
   `sys/kernel/debug/mali*/dvfs_utilization`，只接受单 GPU、单文件、JM busy/idle 格式。
   `mali_kbase_dvfs_debugfs.c:35` 直接读缓存计数，不更新或消耗 devfreq 的窗口，不访问 MMIO。
   计算相邻快照的 `100*delta_busy/(delta_busy+delta_idle)`；不使用开机累计比例。
   与 vendor 一样表示不按频率加权的忙碌时间，但窗口约为 manager 的 5 秒（驱动更新有边界延迟），
   无法声称与最近 100 ms 读数逐点相等。debugfs 未挂载/被禁用/无权限则 null，管理器不挂载它。
3. 无 kbase 绑定时沿用 Panfrost：profiling 和全进程 fdinfo 引擎 ns 增量，
   取两个引擎累计增量的最大值/实际单调时间，限制到 100%。
   [内核文档](https://docs.kernel.org/gpu/panfrost.html)确认 profiling 默认关闭及两种引擎字段。
   这是 GPU 忙碌时间近似，不能精确还原引擎并集；权限、开销、客户端流转限制见
   [现有说明](gpu-utilization.md)。不修改内核。

标准 devfreq 没有 busy/total sysfs 或 load；`trans_stat` 只是频率驻留/转换，恒频下
忙闲完全不可区分，因此禁止把它当利用率。r44p0 `backend/gpu/mali_kbase_devfreq.c:293`
已有 busy_time/total_time，但只是 governor 内核回调，非用户接口。
本轮未添加猜测格式的 load 解析器；kbase 已有 PM debugfs 是可用的等价来源。

kbase/Panfrost 缺失清除基线，恢复需两次连续有效快照；设备或后端切换同样重新建立基线。
kbase 任一计数倒退（重置或回绕）留空该区间，下一段正常恢复；约 1099 秒以上窗口
可能隐藏整轮 u32 回绕，也留空。总计数不前进返回 null，不能误报空闲。
debugfs 两个字段读取没有原子快照保证，存在驱动更新边界误差，优先兼容 mpgpu。

## 给 kbase 会话的补丁草案

[kbase-mpgpu.patch](kbase-mpgpu.patch) 仅供另一个会话审阅、调整到最新平台层后合入。
针对只读的 `~/build/kbase-r3/final/source` 中 `platform/vim4/platform.c` 结构编写，
不改其 worktree，不修改其他移植补丁。本草案不代表内核编译或板端已验。

改动只在 T7 平台层：DVFS 回调 WRITE_ONCE 保存 utilisation，class 的只读
utilization 用 READ_ONCE/sysfs_emit 输出；init 建 class/文件，失败释放已注册对象并
走原 PM/clock 回收，term 先移除接口再走原释放。沿用现有 metrics 的 100 ms 定时器，
不新增 timer、不在 sysfs show 中调用 kbase_pm_get_dvfs_metrics，不干扰 governor。
class_create 使用 7.x 单参数 API；只支持 VIM4 单 GPU。权限改为 0444，vendor 的
0644 本来也没有 store，读 API 不变。初值与停表缓存行为均保留。

接收会话需：按最新 reset/devfreq 改动重新定位 init/term；明确包含 linux/device.h；
走既有补丁 series、源码/补丁哈希门禁及 Werror/modpost；检查创建失败回收、重复装卸、
metrics init/term 与 platform init/term 顺序；确认 CONFIG_MALI_DEVFREQ 或 DVFS 启用、
timer 实际运行且 platform_dvfs_event 正被调用。不要为此补丁重新移植整份 mpgpu.c
的频率/调压控制。若 class 名已占用应 probe 失败并报告，不覆盖已有 class。

## 下一次 kbase 或 HDR 的 7.3 窗口（最多 9 分钟）

附加到已有获授权的双锁窗口，不单独启动窗口。预先在离线构建 manager 与配套
sudoers、准备已验硬件 EGL 负载和认证 API 采集脚本。既有窗口负责人负责暂存/恢复；
不切内核、不重启、不解绑 GPU、不发 HID、不测声音。当前运行哪种驱动就验哪种，
另一种留到后续窗口，不能声称同时通过。

| 时间 | 检查与证据 |
|---|---|
| 0–1 分 | 保存 uname、模块/build ID、manager 提交、绑定驱动、mpgpu、debugfs dvfs_utilization、devfreq 文件清单及 profiling 初值。确认 helper 精确 sudo 规则有效；Panfrost 首次启用允许空值 |
| 1–2 分 | 空闲每 5 秒保存原始来源、helper timeNs 与 API history。稳定计数空闲应接近 0；缺数据必须 null |
| 2–4 分 | 同一硬件 EGL 客户端持续负载 40 秒、50% 占空比 40 秒、空闲 20 秒；保存 renderer/完成次数。负载显著高于空闲、无 timeout/reset，结束恢复空闲 |
| 4–5 分 | 重算相邻 helper 的忙闲比例（Panfrost 取最忙引擎）；验证 5 秒窗口和一次 10 秒间隔。mpgpu 与 API 只比较相近时刻的最新 DVFS 读数，不能要求 5 秒平均相等 |
| 5–6 分 | 仅在隔离 mount namespace 的测试管理器实例遮蔽当前来源后恢复，观察 null→重新建立基线→有效；不重启生产服务，不改内核计数、不解绑驱动 |
| 6–8 分 | Panfrost 用精确 sudo 命令采样 20 次记录 CPU/墙钟成本，目标每次 CPU <50 ms；kbase/mpgpu 确认不启用 Panfrost profiling。保留失败/超时，不能只报中位数 |
| 8–9 分 | 保存日志及 API，按原窗口约定恢复暂存管理器/共享 profiling 状态，核对服务和原文件哈希 |

计数回绕、计时无进展、长窗口以及异常格式用离线 fixture；不在板上伪造计数。
本清单是待验工作，不是本轮通过证据。

## 离线验证（2026-10-31）

- 前端按锁安装和 `pnpm --dir web build` 通过；manager 本机及 Linux ARM64 构建通过。
- 完整 Go 套件交叉编译为 Linux ARM64，在 OrbStack vim4-build 的 `/tmp` 执行通过。
  本机 `go test -race ./internal/board` 也通过。
  新测试覆盖现有三种来源、优先级、缺失自动恢复、异常格式、busy 回绕/idle 重置、
  无计数推进、非正窗口、延迟窗口和可能隐藏整轮回绕的长窗口。
- `git apply --check` 对只读 `~/build/kbase-r3/final/source` 通过；草案未应用、未编译。
- Python 部署全套在 VM 临时工作区运行 220 项，4 项失败；以相同公共 board 依赖对
  未修改的 `0c89b29` deploy 复跑，同样 220 项、同样 4 项失败：
  `DiskRoundTripTest` 的 create_limits、real_fat_round_trip、snapshot_limits、upload_bounds。
  都是既有中文正则断言与英文错误文本不匹配；本轮没有修改磁盘实现或测试。
- Mac 首次 Go 检查受外部 GOROOT 与工具版本不一致影响，移除该命令的 GOROOT 后恢复；
  Mac 全套另有 NAS 空闲空间门槛失败，因此完整通过结论来自 Linux VM，不来自 Mac。
  Python 测试临时工作区保留标准 manager/board 相邻布局，避免独立 worktree 的相对导入失败。

原始检查日志位于执行机 `/tmp/manager-gpu-go-vm.log`、
VM `/tmp/manager-gpu-python.log` 和 `/tmp/manager-gpu-baseline-python.log`；
它们是离线证据，不是上板或性能通过证明。
