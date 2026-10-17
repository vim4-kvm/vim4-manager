# vfat 接入约定

调用顺序：`Scan(ctx, root, ScanOptions)` → `Build(Tree, Options)` →
`NewVolume(Layout, Source)` → `NewMemoryOverlay` / `OpenFileOverlay` →
主机安全卸载、停止写入 → `Parse` → `BuildPlan`。
`Result.ReadFileAt` 根据解析后的簇链提供 Write 操作的内容。
库只返回计划，不操作 NAS、不执行回收或冲突副本写入。

`Tree`、`Layout`、`Result` 及其中的切片在构造完成后应视为不可变。
`Source.ReadAt` 必须支持并发读取，并以 SourceID 寻址快照文件；文件内容和
元数据应与挂载快照保持一致。若 NAS 文件被外部修改，Source 适配器应检测并
返回错误，不能静默读入变动后的内容。回写前仍须执行下述冲突检查。
Scan 不跟随已有符号链接；扫描期间根目录及目录结构必须由调用方保持稳定，
它不提供防止并发目录替换攻击的文件系统沙箱。

## 布局与读取

- 512 字节扇区、两份 FAT、无分区表；`Geometry` 提供数据区与簇偏移。
  新布局（`LayoutAligned`，版本 2）将每份 FAT 长度补齐到 4 KiB，并增加保留
  扇区（至少 32）使数据区起点按簇大小对齐；两份 FAT 起点均按 4 KiB 对齐。
  FSInfo 仍在扇区 1，备份引导/FSInfo 仍在扇区 6/7，其余保留区读为零。
  对齐避免 4 KiB overlay 块跨簇污染脏簇判断，也有利于主机写入性能。
  FAT 只保存分配区间，读取时二分查找；文件内容不在库内缓存。
- `Options.Size=0` 时按占用量加 `WritableBytes` 分配；显式大小不足则报错。
  两种模式都会放大至至少 65525 个数据簇。32 位扇区计数的实际最大值为
  2 TiB 减 512 字节。默认簇大小按微软 FAT32 推荐表选择，新布局下限为 4 KiB，
  显式簇大小也不得小于 4 KiB（因此新布局最小卷约为 256 MiB）。
- `Layout.Skipped` 保留每个排除根路径与原因；被排除目录的整个子树都不进入卷。
  Scan 的 `ExcludeName` 在扫描时完全排除指定名称；Build 也提供同名选项。
- Scan 默认最多 100 万项、128 层；Build 默认 64 层、64 MiB 目录簇空间。
  目录超过 65535 个物理目录项（含 LFN、点项和终止项）时报告后续项为跳过。
- 所有 FAT 时间均为 UTC，向下取到偶数秒，年份钳制到 1980–2107。
  长名使用 UTF-16；可无损表示的 ASCII 8.3 名称用 NT 大小写标志。

## 写入层恢复

Overlay 按 4096 字节块执行读改写，与 FAT 簇大小无关；读写由互斥锁串行化。
`DirtyClusters` 保守地包含整个脏块覆盖的数据簇。新布局每个数据块只属于一个簇，
保守性的影响仅限同一簇内；目录写入或文件原地修改不会连带标脏相邻文件。
即使写入字节与原内容相同，该簇仍算脏；不会将有脏簇的文件判定为内容未变。

调用方应在快照中持久化显式的 `Options.LayoutVersion`。`Build` 的零版本默认
选择新布局；恢复旧快照时，调用方须将缺省版本转换为 `LayoutLegacy`（版本 1）。
旧算法保留 32 个保留扇区和原簇大小选择，精确重建旧布局及其 ID，不迁移已有 overlay。
旧布局仍可能因未对齐或簇小于 4 KiB 将未改动的相邻文件判为 Write。

文件实现使用 `path` 稀疏数据文件及 `path.index` 索引，权限均为 0600。
索引有版本、块大小、卷长度及绑定完整布局/快照元数据的 SHA-256 ID。
首版块写入其逻辑偏移；重写的块副本追加到卷尾，旧版本保持完整。
每个块先同步数据，再追加并同步带 CRC 的索引记录；创建时也同步父目录。
成功返回的 WriteAt 已同步。多块写入不是事务，错误或崩溃可留下部分已提交块；
重开会丢弃不完整的尾记录，数据校验失败会报错。写入发生 I/O 错误后须关闭重开。
初始化中断、索引头损坏或数据文件丢失会拒绝重开，不能自动重建索引。
只有一个进程可以拥有同一对文件；不实现跨进程锁、索引压缩、旧块回收。

## 解析与计划

Parse 仅在完整校验成功后设置 `Result.Safe=true`；结构错误返回
`*ConsistencyError`，资源上限、取消或底层 I/O 错误也禁止生成计划。
两份 FAT 不一致、FAT 状态位异常列入 Warnings，调用方可额外禁止回写。
不实现 fsck 修复、分区表、FAT12/16、exFAT；不扫描和回收不可达的孤立簇。
无 LFN 的 OEM 短名按 CP437 解码，其他传统代码页未自动探测。
Reader 默认最多 100 万节点、16777216 个可达簇、64 MiB 目录内容、64 层；
可通过 ReaderOptions 调整。FAT 按扇区读取，不物化整表；簇所有权校验需要
与可达簇数成正比的内存。两份 FAT 比较会读取完整 FAT 区域。

执行方必须先检查全部 `Plan.Preconditions` 的原路径 size/mtime/SourceID，
以及 `AbsentPaths` 的不存在条件，之后才能按 Steps 顺序执行；目录 size 为 0，
检查目录时使用身份、mtime 及列出的子项条件。目录移动也检查被跳过/忽略的子项。
冲突时不应继续执行原计划，而应保留 NAS 当前内容、从最终镜像生成冲突副本。
`ConflictName` 提供 UTC 命名并保证 255 UTF-16 单元上限；执行方仍需处理同秒重名。
`PendingConflicts` 为需要校验的原路径数量，不代表已发现冲突。

新目录通常先创建；交换名称、占用目标及移动父目录的场景按依赖关系先暂存，
再安装目标目录/文件，再 Write，最后回收、Rmdir、恢复最终时间。
临时路径必须独占创建；执行方负责持久化执行进度和失败恢复。
忽略项与 Skipped 原项不会因为在卷中消失而被删除；最终路径若会替换受保护的
原项则直接拒绝计划。空文件没有可用于唯一认领的首簇，异路径空文件采用
Write + Delete；有脏簇的移动文件也采用 Write + Delete。

## 离线与真实工具验证

```sh
go test ./internal/vfat
go test -race ./internal/vfat
GOOS=linux GOARCH=arm64 go test -c -o "$HOME/Library/Caches/vfat.test" ./internal/vfat
orb -m vim4-build bash -lc '/Users/deepdream/Library/Caches/vfat.test -test.v'
```

真实工具测试只在 Linux 且存在 dosfstools/mtools 时运行，否则明确 Skip。
Mac 的 `/tmp` 不是 VM 的 `/tmp`；测试二进制放在 VM 可见的用户目录。
测试使用临时镜像，不连接板子或挂载实际 NAS。

2026-10-17 验证：Mac Go 1.26.6 包测试及 race 通过；三项真实工具测试在 Mac
明确跳过，在 vim4-build ARM64 VM 中全部运行通过（fsck.fat 4.2、mtools、mkfs.fat）。
由于 worktree 未生成 web/dist，在临时仓库副本中按锁文件构建前端后，
`go test ./...`、`go vet ./...` 和主程序构建全部通过；未在其他工作树目录生成文件。
部署辅助测试在包含公共 board 模块的临时副本中通过：99 项，Mac 跳过 12 项 Linux 测试。
