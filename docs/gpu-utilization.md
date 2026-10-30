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

khadas 服务经精确 sudoers 授权调用 `/opt/vim4-manager/vim4-manager gpu-snapshot`：
从 `/sys/bus/platform/drivers/panfrost/*/profiling` 发现设备，必要时写 1，然后读取
所有 `/proc/[pid]/fd/*` 链接，只读取目标为 `/dev/dri/renderD数字` 或 `/dev/dri/card数字`
的 fdinfo，包括其他用户的进程。只扫描 khadas 会漏掉 root/其他服务负载，
所以需要 root 快照命令。sudoers 只增加该路径和单个固定参数的授权，无通配符或路径参数；
不增加 capability。仅刚开启 profiling 的那次返回 null。
新程序需配套更新 sudoers；缺少授权时查询失败，仍显示无数据。

profiling 开启后会增加每作业时间/周期计数读取和 cycle counter 引用操作，有功耗及性能成本，
尚未量化，不能声称零开销。每 5 秒启动一次原生 Go 快照命令，扫描成本随全机 fd 数增加；
程序为该命令设置 2 秒期限，失败留空，不让慢扫描产生旧值。
profiling 保持开启直到重启或其他管理员关闭；管理器下次采样会重新开启。
不在进程退出时关闭共享开关，以免破坏其他监控工具；停用本功能需停止管理器采样后再关闭。

### 采样频率与开销优化（2026-10-30 第三轮）

`cmd/vim4-manager/main.go` 启动 `history.Run(ctx, 5*time.Second)`：启动立即采一次，
随后约每分钟 12 次，独立于网页请求。已有 `cpu-power-snapshot` 每次采样同样调用
`sudo -n` 启动 Python helper、读取计数、输出 JSON，超时也为 2 秒。
Panfrost 增加每分钟 12 次原生快照调用；Vendor 路径不增加 GPU helper 调用。
CPU helper 读取 `/proc/stat` 及 CPU EM/OPP/频率状态，GPU helper 则枚举所有进程及 fdinfo，
后者工作量随进程数、fd 数及文本大小增长，不能用 CPU helper 的存在证明扫描总是廉价。

此前小规模 VM 数据不足以评估板端成本：上板日志 candidate-gpu.log、b1300-gpu.log
记录旧 helper CPU 中位约 456 ms、墙钟最大约 554 ms，5 秒周期约占单核 9.1%，
不满足每次 CPU <50 ms（单核 <1%）目标。读数正确不代表性能可接受。

第四轮将调用收敛为 Go 直接执行 `sudo -n /opt/vim4-manager/vim4-manager gpu-snapshot`。
`vim4-manager-helper` 恢复纯 Python，不再处理 GPU 转发，其他命令没有额外 shell 启动成本。
Go 命令只在恰好一个 `gpu-snapshot` 参数时进入快照分支，在初始化 Web 服务/账户前返回。
sudoers 的新规则为：

```sudoers
khadas ALL=(root) NOPASSWD: /opt/vim4-manager/vim4-manager gpu-snapshot
```

带参数的命令规则只匹配该完整参数串；没有新增路径参数、环境配置或常驻服务。
需配套更新管理器和 sudoers。VM 已通过 `visudo -cf` 校验。
生产二进制及其父目录必须保持现有 root 所有权，不能让 khadas 替换该特权入口。

安装路径核对：`packaging/ubuntu/package.py:manager()` 将管理器放到上述绝对路径（0755），
将当前 sudoers 放到 `/etc/sudoers.d/vim4-manager-helper`（0440），postinst 执行 visudo。
已实际运行该打包暂存函数，确认新 sudoers 内容与源码完全一致且权限为 0440。
`board.py deploy` 委托 `install-components.sh`：它校验暂存规则，将未修改的旧包规则纳入
迁移，APT 安装后用 `install -m 0440` 替换为新版。管理员手改规则仍按既有策略拒绝覆盖。
两条安装路径无需改动；安装迁移与离线部署测试已通过，未执行真实部署。

Go 用 CLOCK_MONOTONIC 保持跨快照时间语义，每次完整扫描所有 PID/fd 链接，再筛选 DRM
目标读取 fdinfo。未缓存 PID/fd，因此没有新增客户端发现延迟；客户端去重、profiling
开关、错误留空和恢复行为保持不变。省去 Python 解释器、管理模块导入和非 GPU fdinfo
打开/解析。初步尝试的 Python 提前分流加过滤，在 1 万 fd 的 VM 夹具中仍需约 39 ms CPU，
板端余量不足，因此选择复用现有 Go 二进制，无需额外打包一个守护程序。

可复现基准为 `deploy/benchmark_gpu.py`：OrbStack vim4-build ARM64、Python 3.12.3、
内核 7.2.12，100 个模拟 PID × 每 PID 100 个 fd（其中一个 DRM fd），每组 20 次。
夹具全部在临时目录，profiling 为普通文件，不访问真实 GPU。调用由 VM 用户发起 sudo；
不能替代板端 khadas 的 PAM 成本和真实 proc/sysfs 延迟。所有数据包含新进程启动。

| 测量内容 | CPU 中位 ms | 墙钟中位 / 最大 ms |
|---|---:|---:|
| sudo true | 2.05 | 2.09 / 3.11 |
| Python 空程序，不带 sudo | 4.07 | 4.11 / 5.49 |
| sudo + Python 空程序 | 5.40 | 5.55 / 6.22 |
| 旧版 helper 模块导入，含 sudo/Python | 39.62 | 39.81 / 47.64 |
| 旧版导入 + 1 万 fdinfo 扫描 | 84.06 | 84.25 / 93.13 |
| 生产 Go 命令无 GPU 来源，含 sudo | 2.21 | 2.28 / 13.36 |
| Go 扫描探针 + 同一夹具，含 sudo | 10.42 | 10.24 / 11.98 |

旧版模块导入的增量约 34.2 ms，扫描增量约 44.4 ms；sudo 约 2 ms，解释器约 4 ms。
Go 扫描用交叉编译的 board 测试二进制，包含测试框架启动，不是生产端到端测量。
折算该探针单核约 0.21%，旧版约 1.68%，CPU 降低约 88%。真实 Panfrost fdinfo
未包含在扫描探针内，不能据此宣称板端已达 <50 ms。

第四轮同规模、20 次重跑：旧版完整扫描 CPU 中位 91.12 ms、墙钟最大 107.57 ms；
Go 探针 CPU 中位 12.34 ms、墙钟最大 16.57 ms，折算单核约 0.25%。
生产 Go 命令无来源时 CPU 中位 2.34 ms。原始日志位于 `build/gpu-manager-round4/`；
这些是离线探针数据，不是板端精确 sudoers 授权的运行验收。

基准复跑：先将 `c2bd660:deploy/vim4-manager-helper` 保存为 baseline 文件；
交叉构建 manager 和 `go test -c ./internal/board`，再在 VM 执行：

```sh
python3 deploy/benchmark_gpu.py --baseline /path/helper-before \
  --native-test /path/board.test --manager /path/manager-arm64
```

测试探针的夹具环境变量仅存在于测试二进制，安装的 helper/manager 不接受夹具路径。
Go 单测还用 1000 个非 DRM 链接和不可读 fdinfo 验证它们不被打开，避免回归全量读取。
原始测量、脚本输出及本轮测试日志位于本地工作区 `build/gpu-manager-round3/`。
2 秒超时不是开销预算：它相当于周期的 40%，
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

优化后只需在 **213f2715** 复验以下两项（合计约 3 分钟）：

1. 使用配套 manager/sudoers，以 khadas 执行真实 `sudo -n /opt/vim4-manager/vim4-manager gpu-snapshot`
   20 次，每 5 秒一次；用原测量脚本的子进程 CPU 时间和墙钟计时保存原始样本。
   通过判据为每次 CPU <50 ms（中位数及最大值均报告），无失败/超时；不以 VM 数据代替。
2. 沿用已验硬件 EGL 程序，自动空闲 20 秒、满载 30 秒、退出负载后恢复空闲 20 秒，
   每 5 秒保存 API 和 helper 快照。通过判据为空闲/恢复后约 0%、稳定满载约 98%，
   客户端退出可留空一个区间，之后自动恢复，无旧负载残留、GPU timeout/reset。

以下较完整清单保留用于其他版本/发布回归，本轮不要求重复：

以下均是待执行步骤，不是本轮通过证明。只在板端运行脚本和读取已认证的
`GET /api/status` JSON（history[].t、gpu），不产生 HID 事件，不播放或测量声音。
每个内核测试窗口不超过 10 分钟，预先准备板端 EGL surfaceless/pbuffer 压测程序，
程序需输出 GL_RENDERER、提交/完成次数和单调时间，拒绝 llvmpipe/软件回退；
用脚本控制循环占空比和退出，不依赖显示器、键鼠或人工切换。

| 所需内核 | 自动操作步骤 | 通过判据 |
|---|---|---|
| 5.15 Vendor | 脚本采集 utilization 与 API 各 30 秒，记录 GPU 负载程序完成计数；校验 helper 调用日志 | API 保持整数 0–100/无效 null 的厂商语义，不调用 gpu-snapshot，不写 profiling；相近采样的值一致（考虑 DVFS 周期错位） |
| b1300eb 和 213f2715，各执行 | 脚本枚举上述 devfreq 文件及 profiling；以 khadas 执行 `sudo -n /opt/vim4-manager/vim4-manager gpu-snapshot` 两次，再轮询 API 30 秒 | 只找到一个 Panfrost，快照可读其他用户 fdinfo；启用时首个快照 null，此后字段完整；稳定空闲无计数增量时 API 为 0，初始窗口可为空 |
| b1300eb 和 213f2715，各执行 | 保持同一 EGL 客户端，依次空闲 20 秒、持续提交并等待完成 40 秒、50% 占空比 40 秒、空闲 20 秒；同时每 5 秒保存 helper 快照/API，按 timeNs 重算 | 计数随完成次数增加；API 在 0–100，负载中位数高于空闲；完整稳定窗口与快照公式相符（独立采样允许边界误差），停止后恢复空闲；50% 档不要求精确 50% |
| b1300eb 和 213f2715，各执行 | 脚本以两个用户启动两个 EGL 客户端，复制/继承 GPU fd；记录 client-id；自动退出其中一个再启动替代客户端，各观察 20 秒 | 相同 client-id 只计一次，两个客户端均被覆盖；集合变化的区间留空，随后恢复，无虚假满载尖峰 |
| b1300eb 和 213f2715，各执行 | 在预留测试管理器实例中用 mount namespace 遮蔽 profiling 来源，再恢复挂载；保持其他服务不变，连续保存 API；另写 profiling=0 后读 helper | 遮蔽时新样本为 null，恢复经重新建立基线后返回有效值；关闭后 helper 重开并返回 null，不沿用旧窗口；不解绑 GPU 驱动 |
| b1300eb 和 213f2715，各执行 | 用同一 EGL 负载脚本运行 profiling 关闭/开启的 60 秒 A/B/A；关闭阶段避免管理器采样自动重开；记录完成次数、CPU 时间、helper 耗时及内核日志 | 报告吞吐、CPU 与扫描开销差异；无新增 GPU timeout/reset，helper 每次低于 2 秒；若出现显著退化则不得宣称性能验收通过 |

计数回绕用离线夹具验证，不在板上修改内核计数器。真实性能误差和实际 sysfs/procfs
访问权限必须以两个目标内核分别记录，不能用离线测试或一个内核替代另一个。
