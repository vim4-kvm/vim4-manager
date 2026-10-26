# shadcn-admin 界面适配

以 [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin/tree/e16c87f213a5ba5e45964e9b67c792105ec74d26)
的布局、Slate 配色和仪表盘卡片为基础，接入现有管理器。上游采用 New York 组件风格；
本项目保留现有 Radix 组件及接口，调整公共组件的尺寸、边框、间距和字重。
上游 MIT 版权与授权保存在 [许可证](../../LICENSES/shadcn-admin.txt)。

本轮设计替代 [上一轮规格](spec.md) 中固定展开的 232px 侧栏、880px 内容区、品牌蓝色和手机隐藏标题的约定；
原规格中的业务行为、按页加载、轮询生命周期和减少动态效果的约定继续保留。

- 导航分为「控制台」「设备」「系统」，展开宽度 256px，桌面可收起为图标栏。
  收起时仍保留页面名称的可访问标签和悬停提示。手机使用抽屉，点击页面后关闭。
- 顶栏显示分组与当前页面，右上角提供太阳/月亮图标的外观菜单与账户菜单；
  外观菜单支持浅色、深色和跟随系统，当前选项显示勾选。侧栏底部显示连接与内核。
- 各页使用统一的宽内容区，设置卡片按内容分栏并在窄屏堆叠。
  页内标题在桌面和手机均显示。
- 概览按确认后的效果图实现：顶部状态条与 HDMI、USB、PD、虚拟介质四项指标，
  中间为资源趋势与当前 KVM/快捷操作，底部为最近事件和设备健康。
  六种资源通过页签切换，可查看最近 5/15 分钟；图表沿用实际采样、动态轴范围与键盘提示，
  缺失功耗数据不补零。内存与系统盘使用率、风扇、温度和网卡状态汇总到设备健康。
  接口没有远程会话数、编码格式与码率汇总，以真实虚拟介质状态代替效果图中的新增指标。
  刷新按钮立即读取设备状态；读取失败时保留旧数据并明确显示连接中断与上次更新时间。
- 其余 11 页按确认后的效果图改造：KVM 显示当前运行摘要、应用卡片和共用设备；
  虚拟介质突出当前介质，镜像库与来源说明并排。数据盘采用左侧选盘、右侧文件管理，
  新建使用对话框；备份与快照常驻，卷标、检查、扩容、格式化与删除收进「维护」。
  原有挂载限制、安全弹出、名称确认和上传离页保护继续生效。
- 网络存储显示连接数、所选 NAS 可用空间、虚拟 U 盘状态、连接卡片和详情；
  可用空间只取所选连接，不累加可能指向同一卷的共享。已保存连接可直接测试，沿用已有 API。
  NAS 扫描、回写和冲突决策继续使用原有活动面板。
- 视频输入先显示真实信号摘要，再并排展示 EDID 预设与 HDR 映射；
  HDR 保留实时预览、松开保存和现有 SDR 输出曲线，没有加入效果图中的 EDID 导出占位操作。
  HDMI 输出增加信号路径图，输出设置、显示器能力和信号格式分区；
  不支持、切换中、断流、缩放、HDR 转 SDR 与读取失败等状态保持原逻辑。
- 散热显示温度和占空比指标、可拖动曲线与当前策略，曲线沿用实际驱动插值与限值。
  网络页增加有线网络摘要，Wi-Fi 与 Tailscale 在宽屏并排。
  服务页增加运行/完成/异常统计，仅允许后端明确标记可维护的服务重启。
  更新页分为内核卡片与软件版本表；账户页分为管理员凭据与登录设备表。
- 登录页沿用独立入口与现有账户流程，使用一致的品牌图标、卡片与深浅色，
  沿用主题偏好，不再单独显示外观切换控件。

API、Go 后端、KVM 网关和哈希路由保持现有实现。没有引入 TanStack Router、
React Query、Clerk 或上游演示业务；没有新增 npm 依赖和测试文件。
本机与上板验证结果见下文。

本地预览：`pnpm --dir web dev`。真实 API 仍通过 `VIM4_MANAGER` 显式指定，
默认代理到本机 5189。下列截图使用现有离线 fixture，展示模拟状态；
概览与下列 11 页截图均已更新为效果图落地后的布局。

| 页面 | 截图 |
|---|---|
| 概览 | [桌面浅色](screens/shadcn-admin/overview-light-1280.png)、[桌面深色](screens/shadcn-admin/overview-dark-1280.png)、[手机深色](screens/shadcn-admin/overview-dark-390.png) |
| 导航 | [桌面收起](screens/shadcn-admin/sidebar-collapsed-light-1280.png)、[手机菜单](screens/shadcn-admin/mobile-menu-dark-390.png) |
| KVM 界面 | [浅色](screens/pages-design/apps-selected-light-1280.png)、[深色](screens/pages-design/apps-selected-dark-1280.png)、[手机](screens/pages-design/apps-selected-dark-390.png) |
| 虚拟介质 | [浅色](screens/pages-design/media-mounted-light-1280.png)、[深色](screens/pages-design/media-mounted-dark-1280.png) |
| 数据盘 | [浅色](screens/pages-design/disks-files-light-1280.png)、[深色](screens/pages-design/disks-files-dark-1280.png) |
| 网络存储 | [浅色](screens/pages-design/storage-connected-light-1280.png)、[深色](screens/pages-design/storage-connected-dark-1280.png) |
| 视频输入 | [浅色](screens/pages-design/video-synced-light-1280.png)、[深色](screens/pages-design/video-synced-dark-1280.png)、[手机](screens/pages-design/video-synced-dark-390.png) |
| HDMI 输出 | [浅色](screens/pages-design/output-final-light-1280.png)、[深色](screens/pages-design/output-final-dark-1280.png) |
| 散热 | [浅色](screens/pages-design/cooling-current-light-1280.png)、[深色](screens/pages-design/cooling-current-dark-1280.png) |
| 网络 | [浅色](screens/pages-design/network-client-light-1280.png)、[深色](screens/pages-design/network-client-dark-1280.png) |
| 底层服务 | [浅色](screens/pages-design/services-running-light-1280.png)、[深色](screens/pages-design/services-running-dark-1280.png) |
| 更新 | [浅色](screens/pages-design/updates-available-light-1280.png)、[深色](screens/pages-design/updates-available-dark-1280.png) |
| 账户 | [浅色](screens/pages-design/account-devices-light-1280.png)、[深色](screens/pages-design/account-devices-dark-1280.png)、[手机](screens/pages-design/account-devices-dark-390.png) |
| 登录 | [浅色](screens/shadcn-admin/login-light-1280.png)、[深色](screens/shadcn-admin/login-dark-1280.png) |

首轮界面适配（外观菜单调整前）验证：`pnpm --dir web build`（包含 TypeScript 检查）、现有 15 个浏览器行为回归均通过，
认证回归包含 22 个场景。`env -u GOROOT go test ./...` 与 `env -u GOROOT go build ./...` 通过；
命令级移除本机遗留的 GOROOT，避免 Go 1.27 与 1.26 工具目录混用，未改本机配置。
截图包含桌面展开/收起、手机导航与浅色/深色；没有横向溢出。

## 板子预览部署（2026-10-25）

预览地址：<http://192.168.50.210>。分支 `ui/shadcn-admin`，部署源码为
`0c3965ff28eaa14c871a9ee7d1d44d1cbde06e80`，管理器包版本为
`2.5.1+vim4.20261025.16`。只更新 manager，未推送分支或发布版本。

ARM64 包构建和 `ubuntu-build.py verify --component manager` 通过。
安装后按板子实际内核 `5.15.137-vim4kvm-hdrdual6` 执行 `board.py check` 通过；
首次收尾检查使用默认内核名而未通过，补充实际内核名后通过，未改动内核。
One-KVM、HDMI、tvserver 和 gadget 的进程与启动时间在安装前后完全一致。

复用现有上板页面检查：12 个桌面页面 API 均返回 200，手机检查概览、视频输入和 HDMI 输出，
无浏览器错误、页面异常或横向溢出。除登录外均为读取请求，未修改设备设置。
本机 Chrome 直连局域网失败，页面检查通过 SSH 将板子 80 端口转发到本机 5211 执行。
原始操作日志、服务对比、16 张截图及 `verification.json` 保存在本机
`/tmp/vim4-shadcn-admin-deployed/`；这些临时证据不会随仓库分发。

### 外观菜单调整

后续按反馈将外观切换移到右上角，并移除登录页底部控件。源码 `2b220d6`，
管理器包 `2.5.1+vim4.20261025.17` 已部署至同一地址。前端构建、ARM64 包构建与包验证、
安装后服务检查、上述 12 页及手机页面巡检通过。另核验桌面/手机外观菜单的三项选择、
刷新保留偏好、跟随系统和登录页无切换控件；没有新增或修改测试文件。
本次服务进程与启动时间在安装前后完全一致。证据在 `/tmp/vim4-theme-menu-deployed/`。

### 概览效果图落地

概览实现提交为 `cbd7a7c`，包版本 `2.5.1+vim4.20261025.18`，已部署至同一地址。
没有新增依赖或测试文件。前端构建通过；ARM64 打包流程中的根仓离线检查、
管理器 helper 检查与 Go 测试通过，包校验和安装后服务检查通过。

离线页面核验覆盖 390/768/1024/1280/1440px、浅色/深色、六个资源页签、键盘图表提示、
5/15 分钟范围、快捷链接、手动刷新、连接中断保留旧值和缺失数据。
复用既有 `power.mjs` 的 PD S1–S5 与功耗缺口/零值检查，在临时脚本中适配新页签和单图选择器后通过，
未改仓库中的测试。概览截图已更新为本轮离线数据预览。

上板复用 12 页巡检，另核验真实概览的桌面/手机深浅色、资源切换、时间范围与只读刷新。
巡检除登录外均为读取请求；One-KVM、HDMI、tvserver 和 gadget 的进程与启动时间在安装前后完全一致。
本次没有验证视频、音频、HID 或延迟端到端性能。临时操作日志、服务对比、截图与
`verification.json` 在 `/tmp/vim4-overview-design-deployed/`。

### 其余 11 页效果图落地

前端构建（含 TypeScript）通过。复用现有 controls、actions、media、storage、nasdisk、
updates、disks、passthrough 浏览器检查，以及 auth 中的账户、设备和退出场景；
在临时副本中适配外观菜单、新建数据盘弹窗、维护入口和新布局，未修改仓库测试。
账户检查的构建产物预览将 `/__vim4/login` 映射到 `login.html`，与正式服务的入口一致。
磁盘切换检查发现并修正了同级组件 key 冲突造成的旧文件面板残留。

沿用离线页面 fixture 检查上述 11 页，在浅色/深色及 390/768/1024/1280/1440px 下
共生成 110 张截图，无页面横向溢出或浏览器错误。本文保留 22 张桌面和 3 张手机截图；
完整临时日志与截图在 `/tmp/vim4-pages-design-verified/`。没有新增依赖、API 或测试文件。

实现提交 `65775de`，管理器包 `2.5.1+vim4.20261025.19` 已部署至
<http://192.168.50.210>，未推送分支或发布版本。ARM64 打包流程中的根仓离线检查、
manager helper 与 Go 测试通过；包校验、安装后服务检查通过。
上板复用现有页面巡检，扩大手机范围至全部 12 页：桌面 API 均为 200，
桌面和手机无浏览器错误、页面异常或横向溢出。巡检除登录外均为读取请求。
One-KVM、HDMI、tvserver 和 gadget 的进程与启动时间在安装前后完全一致，
没有验证视频、音频、HID 或延迟端到端性能。安装日志、25 张截图、服务对比与
`verification.json` 在 `/tmp/vim4-pages-design-deployed/`。
