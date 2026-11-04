# GPU 利用率

本页解释概览 GPU 读数及权限成本；读数不含视频编码器或 CPU。
导航：[语义](#语义) · [权限与开销](#权限与开销) · [验证边界](#验证边界)。
返回[概览](overview.md)。

## 语义

厂商来源是驱动最近 DVFS 周期的忙碌率，不是管理器采样区间平均；存在但无效仍留空。
Panfrost 使用全进程 fdinfo 的引擎时间增量，同一客户端去重后跨客户端汇总，
取最忙引擎来避免流水线重叠重复计数。公式和来源优先级只查 [sampleGPU、estimateGPU](../internal/board/gpu.go)。

这只是近似：不重叠的引擎区间会低估，中断和硬件计时又可能高估，不能称严格数学下界。
未完成长作业延后计时，窗口内出现又退出的客户端会漏计，逐文件读取也不是原子快照。
客户端集合、设备或计数发生不连续变化时留空并重建基线。
完整扫描且 profiling 有效的无客户端状态可报零，权限不足、缺失、格式错误或超时必须报未知。
不能从频率驻留时间或当前频率推算 GPU 忙碌率。

## 权限与开销

必须扫描其他用户的 DRM 客户端，因此使用固定参数的 root 快照入口；
路径与授权查 [main.go](../cmd/vim4-manager/main.go)、[sudoers](../deploy/vim4-manager-helper.sudoers)。
生产二进制及父目录必须保持 root 所有，不能由服务用户替换。
升级程序须同步 sudoers，缺授权显示无数据；安装程序不接受测试夹具路径。

快照按需开启 profiling，开启当次留空。开关由其他监控共享，管理器退出不关闭；
停用时先停止采样再由管理员关闭，否则下次采样会重新开启。
profiling 增加每作业计数成本，尚未量化，不能宣称零开销。
全机扫描成本随进程和 fd 数增长。Go 入口替代 Python 全模块导入和非 DRM fdinfo 读取，
离线探针更快，但不能证明板端真实 sudo/PAM 与 procfs 开销已达标。
GPU 调用处于 history 锁内，慢扫描阻塞历史读取；CPU/GPU 超时串行，超时期限不是开销预算。

## 验证边界

来源扫描查 [gpu_snapshot.go](../internal/board/gpu_snapshot.go)，离线基准参数查
[benchmark_gpu.py](../deploy/benchmark_gpu.py) 的帮助。旧 Python 路径曾有不可接受的板端开销；
逐轮数据不作为当前通过证明。
既有磁盘 Python 回归曾因中文断言与英文诊断不匹配失败，不能归因为 GPU 行为改变。

待实板检查：配套程序与授权下重复采样 CPU/墙钟耗时；
同一 EGL 客户端空闲、满载、退出后自动恢复；多用户及复制 fd 去重；
客户端切换留空、隐藏来源后恢复、关闭 profiling 后重开。
厂商路径应不调用 Panfrost helper。两个内核的权限与性能须分别测量。
开关 profiling 的负载对照须报告吞吐与成本并查 timeout/reset；VM 夹具不能替代这些结果。
自动检查仅取快照/API，不发 HID 或测声音；遵循[占板规范](https://github.com/vim4-kvm/vim4-kvm/blob/main/docs/code-standards.md#上板与测试)。
