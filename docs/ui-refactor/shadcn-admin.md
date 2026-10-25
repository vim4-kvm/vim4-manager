# shadcn-admin 界面适配

以 [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin/tree/e16c87f213a5ba5e45964e9b67c792105ec74d26)
的布局、Slate 配色和仪表盘卡片为基础，接入现有管理器。上游采用 New York 组件风格；
本项目保留现有 Radix 组件及接口，调整公共组件的尺寸、边框、间距和字重。
上游 MIT 版权与授权保存在 [许可证](../../LICENSES/shadcn-admin.txt)。

本轮设计替代 [上一轮规格](spec.md) 中固定展开的 232px 侧栏、880px 内容区、品牌蓝色和手机隐藏标题的约定；
原规格中的业务行为、按页加载、轮询生命周期和减少动态效果的约定继续保留。

- 导航分为「控制台」「设备」「系统」，展开宽度 256px，桌面可收起为图标栏。
  收起时仍保留页面名称的可访问标签和悬停提示。手机使用抽屉，点击页面后关闭。
- 顶栏显示分组与当前页面，右上角统一提供账户菜单；侧栏底部显示连接、内核与外观选择。
- 概览、KVM 界面、文件管理与网络使用较宽内容区；设置页面保持适合阅读的宽度。
  页内标题在桌面和手机均显示。
- 概览将当前应用、四项设备状态、六项资源趋势和事件分区展示。
  图表继续使用实际采样、原有轴范围和联动提示；缺失功耗数据不补零。
- KVM 界面采用双列卡片，网络页在宽屏并排显示 Wi-Fi 与 Tailscale。
  其余页面通过公共卡片、按钮、输入框和页头统一外观。
- 登录页沿用独立入口与现有账户流程，使用一致的品牌图标、卡片与深浅色。

API、Go 后端、KVM 网关和哈希路由保持现有实现。没有引入 TanStack Router、
React Query、Clerk 或上游演示业务；没有新增 npm 依赖和测试文件。
此分支只做本机验证，未部署到板子。

本地预览：`pnpm --dir web dev`。真实 API 仍通过 `VIM4_MANAGER` 显式指定，
默认代理到本机 5189。下列截图使用现有离线 fixture，展示模拟状态。

| 页面 | 截图 |
|---|---|
| 概览 | [桌面浅色](screens/shadcn-admin/overview-light-1280.png)、[桌面深色](screens/shadcn-admin/overview-dark-1280.png)、[手机深色](screens/shadcn-admin/overview-dark-390.png) |
| 导航 | [桌面收起](screens/shadcn-admin/sidebar-collapsed-light-1280.png)、[手机菜单](screens/shadcn-admin/mobile-menu-dark-390.png) |
| KVM / 网络 | [KVM 界面](screens/shadcn-admin/apps-light-1280.png)、[网络](screens/shadcn-admin/network-light-1280.png) |
| 登录 | [浅色](screens/shadcn-admin/login-light-1280.png)、[深色](screens/shadcn-admin/login-dark-1280.png) |

验证：`pnpm --dir web build`（包含 TypeScript 检查）、现有 15 个浏览器行为回归均通过，
认证回归包含 22 个场景。`env -u GOROOT go test ./...` 与 `env -u GOROOT go build ./...` 通过；
命令级移除本机遗留的 GOROOT，避免 Go 1.27 与 1.26 工具目录混用，未改本机配置。
截图包含桌面展开/收起、手机导航与浅色/深色；没有横向溢出。
