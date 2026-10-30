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
全进程、全客户端、两个引擎的 ns 增量总和除以实际单调时钟窗口，再限制到 0–100%。
这是面向整颗 GPU 的近似指标，通常比单一客户端或频率驻留更接近厂商 utilization。
各进程共享/复制 fd 按 drm-client-id 去重，同一客户端的重复读数取各引擎最大值。
VIM4 只支持一个绑定的 Panfrost GPU；发现多个设备时返回 null，避免混合身份。

并行引擎、硬件流水线及中断延迟会高估忙碌时间，因此不能称为精确利用率或严格数学上界。
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
