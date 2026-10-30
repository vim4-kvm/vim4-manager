# GPU 利用率

5.15 继续优先读取 `/sys/class/mpgpu/utilization` 的整数 0–100，保持原有最近 DVFS
周期语义；接口存在但值无效仍为 null。Panfrost 后端不更改前端或 `history[].gpu` 合同。
两者都不包括 Wave5、厂商视频编码器或 CPU 使用率。

## 内核依据与来源选择

离线只读核对 VM `~/src/linux-7.3-hdmi-integration` 的 `213f271505411` 和
部署锁 `b1300eb808f43`，没有修改或检出内核工作树。
两版本的 `panfrost_devfreq.c`、`panfrost_drv.c`、`panfrost_job.c` 和
`drivers/devfreq/devfreq.c` 无差异。接口依据：

- `panfrost_devfreq_get_dev_status()` 的 busy/total 是驱动内部时间，读取后复位。
  devfreq sysfs 的基本文件为 name、governor、available_governors、cur_freq、
  available_frequencies、target_freq、min_freq、max_freq、trans_stat；governor 决定
  polling_interval、timer 可见性。没有 `load`。trans_stat 是频率转换次数与驻留时间，
  包括同一频率的忙闲时间，无法还原忙碌率。上述为源码注册结果，实际设备文件仍待上板确认。
- `panfrost_gpu_show_fdinfo()` 提供 fragment、vertex-tiler 的累计 ns 和 cycles，
  只有 profiling 开启时才输出。`panfrost_dequeue_job()` 在作业退出硬件队列时累计时间。
  不使用 cur_freq 推算忙碌率，也不以 cycles/maxfreq 混入频率权重。
- [标准 fdinfo 合同](https://docs.kernel.org/gpu/drm-usage-stats.html) 和
  [Panfrost profiling 说明](https://docs.kernel.org/gpu/panfrost.html)定义来源及默认关闭原因。

目前标准用户接口不能精确恢复全 GPU「至少一个作业忙」的时间并集。管理器采用
全进程、全客户端的 ns 增量，先分别求 fragment、vertex-tiler 的跨客户端总和，
再取两个引擎总和的最大值，除以实际单调时钟窗口，最后限制到 0–100%。
即 `min(100, 100 * max(sum(delta_fragment), sum(delta_vertex_tiler)) / delta_time)`。
这是面向整颗 GPU 的下界近似：理想引擎时间的并集位于最大值与总和之间；
Mali 的顶点与片元工作通常流水并行，取最大值避免重复计算重叠区间。
例如 fragment 为 60%、vertex-tiler 为 40% 时显示 60%，而不是相加显示 100%。
各进程共享/复制 fd 按 drm-client-id 去重，同一客户端的重复读数取各引擎最大值。
VIM4 只支持一个绑定的 Panfrost GPU；发现多个设备时返回 null，避免混合身份。

两个引擎不重叠的忙碌区间会被低估；完全重叠时理想的最大值等于并集。
驱动的硬件流水线计时和中断延迟仍可能高估单个引擎时间，所以这不是严格数学下界。
未完成的长作业会把时间推迟到完成后的窗口，窗口间出现后又退出的客户端会漏计。
逐文件读取不是原子快照，扫描耗时和先后顺序也会产生窗口误差。
相邻快照客户端集合不同、计数倒退/回绕、设备变化、非正窗口均留空一个区间，然后重新采样。
无客户端但完成全进程扫描且 profiling 有效时可报告 0%；权限不足、格式错误、接口缺失、
helper 失败或超时均报告 null，清除旧基线；恢复后需要两个有效快照。

## 权限、开销和生命周期

khadas 服务经已有 sudoers 调用固定、无参数的 `gpu-snapshot` helper：
从 `/sys/bus/platform/drivers/panfrost/*/profiling` 发现设备，必要时写 1，然后读取
所有 `/proc/[pid]/fdinfo/*`，包括其他用户的进程。只扫描 khadas 会漏掉 root/其他服务负载，
所以需要 root helper；没有增加 capability 或放宽 sudoers。仅刚开启 profiling 的那次返回 null。
新程序需配套更新 helper；旧 helper 拒绝命令时仍显示无数据。

profiling 开启后会增加每作业时间/周期计数读取和 cycle counter 引用操作，有功耗及性能成本，
尚未量化，不能声称零开销。每 5 秒启动一次 Python helper，扫描成本随全机 fd 数增加；
程序为该命令设置 2 秒期限，失败留空，不让慢扫描产生旧值。
profiling 保持开启直到重启或其他管理员关闭；管理器下次采样会重新开启。
不在进程退出时关闭共享开关，以免破坏其他监控工具；停用本功能需停止管理器采样后再关闭。

### 采样频率与离线开销估算（2026-10-30）

`cmd/vim4-manager/main.go` 启动 `history.Run(ctx, 5*time.Second)`：启动立即采一次，
随后约每分钟 12 次，独立于网页请求。已有 `cpu-power-snapshot` 每次采样同样调用
`sudo -n` 启动 Python helper、读取计数、输出 JSON，超时也为 2 秒。
Panfrost 增加每分钟 12 次同类调用，总共约 24 次；Vendor 路径不增加 GPU helper 调用。
CPU helper 读取 `/proc/stat` 及 CPU EM/OPP/频率状态，GPU helper 则枚举所有进程及 fdinfo，
后者工作量随进程数、fd 数及文本大小增长，不能用 CPU helper 的存在证明扫描总是廉价。

在 OrbStack vim4-build ARM64、Python 3.12.3、内核 7.2.12 中分别测量 20 次新进程：
以 `sudo -n /usr/bin/python3` 启动，导入当前 helper；完整扫描组额外调用
`gpu_snapshot(root)`，root 中 profiling 为已开启的临时普通文件，proc 链接 VM 的真实
`/proc`。没有访问板子或启用真实 GPU profiling。运行前枚举约 24 个进程、443 个 fdinfo。
调用由 VM root 发起，不能代表板端 khadas 的 sudo/PAM 成本。

| 测量内容 | 墙钟中位数 / 最大值 | 子进程 CPU 时间中位数 |
|---|---|---|
| sudo + Python + helper 导入，不扫描 | 41.6 / 51.1 ms | 41.3 ms |
| 上述启动 + 完整 VM proc 扫描 | 54.0 / 75.8 ms | 53.7 ms |

按 5 秒周期折算，完整 GPU 采样约占单核 `53.7/5000 = 1.07%`，其中扫描增量约
0.25%；启动成本占主要部分。这个规模下作为低频趋势采样暂可接受，尚无证据需要引入
常驻特权进程或合并 CPU/GPU helper。该测量不覆盖真实 Panfrost fdinfo 处理和内核
profiling 开销，不是板端性能验收。2 秒超时也不是开销预算：它相当于周期的 40%，
且 GPU 调用位于 history 锁内，慢扫描会阻塞历史读取；CPU/GPU 的两个超时串行合计可达
4 秒。板上必须记录扫描耗时分布和 CPU 时间，若经常接近超时，应重新评估实现。

### 基线失败复核

在 detached 临时 worktree 的 `ab7fb63` 和当前 GPU 实现中，以同一 VM、同一命令
`python3 -m unittest discover -s deploy -p 'test_*.py'` 复跑：基线 214 项、当前 216 项，
均仅下列四项失败，异常文本和断言一致，确认为既有中文断言与英文错误信息不匹配：

- `test_create_limits_and_snapshot_validation`
- `test_real_fat_round_trip_snapshot_restore_and_delete`
- `test_snapshot_limits_and_format_failure_preserve_data`
- `test_upload_bounds_overwrite_and_attached_refusal`

四项均属于 `test_disks.DiskRoundTripTest`，本次未改动磁盘行为或这些测试。
原始日志与开销测量脚本保存在本地工作区 `build/gpu-manager-review-20261030/`，不随源码提交。

## 板上待验证清单

以下均是待执行步骤，不是本轮通过证明。只在板端运行脚本和读取已认证的
`GET /api/status` JSON（history[].t、gpu），不产生 HID 事件，不播放或测量声音。
每个内核测试窗口不超过 10 分钟，预先准备板端 EGL surfaceless/pbuffer 压测程序，
程序需输出 GL_RENDERER、提交/完成次数和单调时间，拒绝 llvmpipe/软件回退；
用脚本控制循环占空比和退出，不依赖显示器、键鼠或人工切换。

| 所需内核 | 自动操作步骤 | 通过判据 |
|---|---|---|
| 5.15 Vendor | 脚本采集 utilization 与 API 各 30 秒，记录 GPU 负载程序完成计数；校验 helper 调用日志 | API 保持整数 0–100/无效 null 的厂商语义，不调用 gpu-snapshot，不写 profiling；相近采样的值一致（考虑 DVFS 周期错位） |
| b1300eb 和 213f2715，各执行 | 脚本枚举上述 devfreq 文件及 profiling；以 khadas 执行 `sudo -n /usr/libexec/vim4-manager-helper gpu-snapshot` 两次，再轮询 API 30 秒 | 只找到一个 Panfrost，helper 可读其他用户 fdinfo；启用时首个快照 null，此后字段完整；稳定空闲无计数增量时 API 为 0，初始窗口可为空 |
| b1300eb 和 213f2715，各执行 | 保持同一 EGL 客户端，依次空闲 20 秒、持续提交并等待完成 40 秒、50% 占空比 40 秒、空闲 20 秒；同时每 5 秒保存 helper 快照/API，按 timeNs 重算 | 计数随完成次数增加；API 在 0–100，负载中位数高于空闲；完整稳定窗口与快照公式相符（独立采样允许边界误差），停止后恢复空闲；50% 档不要求精确 50% |
| b1300eb 和 213f2715，各执行 | 脚本以两个用户启动两个 EGL 客户端，复制/继承 GPU fd；记录 client-id；自动退出其中一个再启动替代客户端，各观察 20 秒 | 相同 client-id 只计一次，两个客户端均被覆盖；集合变化的区间留空，随后恢复，无虚假满载尖峰 |
| b1300eb 和 213f2715，各执行 | 在预留测试管理器实例中用 mount namespace 遮蔽 profiling 来源，再恢复挂载；保持其他服务不变，连续保存 API；另写 profiling=0 后读 helper | 遮蔽时新样本为 null，恢复经重新建立基线后返回有效值；关闭后 helper 重开并返回 null，不沿用旧窗口；不解绑 GPU 驱动 |
| b1300eb 和 213f2715，各执行 | 用同一 EGL 负载脚本运行 profiling 关闭/开启的 60 秒 A/B/A；关闭阶段避免管理器采样自动重开；记录完成次数、CPU 时间、helper 耗时及内核日志 | 报告吞吐、CPU 与扫描开销差异；无新增 GPU timeout/reset，helper 每次低于 2 秒；若出现显著退化则不得宣称性能验收通过 |

计数回绕用离线夹具验证，不在板上修改内核计数器。真实性能误差和实际 sysfs/procfs
访问权限必须以两个目标内核分别记录，不能用离线测试或一个内核替代另一个。
