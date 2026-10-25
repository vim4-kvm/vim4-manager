# vim4-manager 前端重构规格（设计：Claude 主会话；实现：子代理）

## 目标
用统一组件体系替换 5711 行手写 `styles.css` 与自绘图标，功能、接口、文案完全不变，视觉更统一、可访问性更好、深浅色一致、手机可用。

## 技术栈（定稿）
| 用途 | 选型 | 约束 |
|---|---|---|
| 样式 | Tailwind CSS v4（`@tailwindcss/vite`） | 只用工具类；不写组件级 CSS 类 |
| 组件 | shadcn/ui，style **Nova**（紧凑密度），Radix 原语 | 组件代码放 `web/src/components/ui/`，用 CLI 或按官方源码引入；不魔改除非规格要求 |
| 图标 | lucide-react | 删除 `Icons.tsx`；统一 `size-4`（行内）/`size-5`（导航），`strokeWidth` 默认 |
| 状态 | zustand | 取代 App 向下传递的 busy/stale/run/status/passthrough |
| 提示 | sonner（shadcn Toaster） | 取代现有全局 busy 横幅的完成/失败提示 |
| 动画 | 暂不引入 Motion | 只用 Tailwind/Radix 自带过渡（data-state 动画） |
| 不引入 | react-resizable-panels、dnd-kit、recharts | 当前没有分栏/拖拽需求；图表沿用 Charts.tsx 自绘 SVG，仅改为 token 着色 |

**手写 CSS 上限**：全部自定义 CSS 只允许出现在 `web/src/index.css`：`@import "tailwindcss"`、shadcn 主题变量与 `@theme inline` 映射、`@custom-variant dark`、极少量 base（字体、`theme-switching` 时禁用过渡）。总计 ≤ 150 行。`styles.css` 最终删除。不允许内联 `style={{}}` 做布局/颜色（图表坐标、进度百分比等数据驱动值除外）。

## 设计令牌（沿用现有品牌色，映射到 shadcn 变量）
浅色 / 深色：
- background `#f4f5f7` / `#121315`；card、popover `#ffffff` / `#1c1d21`；sidebar `#ffffff` / `#18191c`
- foreground `#1d2025` / `#e9eaec`；muted-foreground `#6f767f` / `#80858d`（次级文字 `#50565e` / `#a9adb4` 作为 `--secondary-foreground`）
- border `#e6e8eb` / `#2a2c31`；input `#d3d7dc` / `#3a3d43`；muted、accent（悬停底）`#f7f8fa` / `#232429`
- primary `#006fff` / `#3d8bff`，primary-foreground `#ffffff`；ring = primary
- destructive `#ee3a3e` / `#ff5a5f`
- 新增状态 token（Tailwind 可用 `text-success` `bg-success` 等）：success `#1fa855`/`#3ccf72`，success-foreground（文字）`#15803f`/`#4fd884`；warning `#f5a524`/`#f7b23b`，warning-foreground `#9a5b00`/`#f7b23b`；idle `#b2b7be`/`#5b6068`
- radius：`--radius: 0.625rem`（卡片 10px），控件用 `rounded-md`（6px）
- 字体：`system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif`；等宽 `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace`；基准 14px，行高 1.55
- 阴影：浅色卡片 `shadow-xs`，深色无阴影
- 深色模式：改为 `<html class="dark">`（保留 theme.tsx 的 light/dark/system 三态与切换时禁用过渡逻辑），QR 码始终白底黑码

## 布局
- 桌面（≥ 768px）：shadcn `Sidebar`（固定宽 232px，不可折叠成图标条），右侧内容区 `max-w-[880px]`，左右 padding 32px，顶部 32px。
- 页头：`h1` 页面标题（text-xl font-semibold）+ 可选描述（text-sm text-muted-foreground，max-w-prose），下方 24px 起内容。
- 侧栏项：Lucide 图标 + 标题 + 右侧状态提示（现有 navHint 文案，tone→ 小圆点 + text-xs；good=success、warning=warning、critical=destructive）。底部：账户菜单（DropdownMenu）、主题切换（三态 ToggleGroup 或 DropdownMenu）。
- 手机（< 768px）：顶部 56px 栏（菜单按钮 + 当前页标题 + 账户按钮），侧栏变 Sheet（左侧滑出），内容 padding 16px；所有设置行在窄屏下标题/说明占满一行，控件右对齐不被挤压，长状态文字允许换行。
- 侧栏页面图标建议：概览 LayoutDashboard、KVM 界面 MonitorPlay、虚拟介质 Disc3、数据盘 HardDrive、网络存储 Server、视频输入 Video、HDMI 输出 MonitorUp、散热 Fan、网络 Wifi、底层服务 Cpu、更新 RefreshCw、账户 UserRound。

## 共享组件（`web/src/components/`，所有页面必须复用，禁止各页自造）
1. `SettingsCard`：shadcn Card，可选标题/描述；内部若干行之间 `Separator`。
2. `SettingRow`：左侧标题（text-sm font-medium）+ 说明（text-sm text-muted-foreground）；右侧「状态文字 + 控件」。props：title, description, status（文字）, pending（显示 Loader2 animate-spin）, control（Switch/Button/Select…）, inactive（控件灰态但可操作，对应现有 is-inactive 语义）。
3. `FactGrid` / `Fact`：`dl` 网格（桌面 3 列，窄屏 1 列）；每项 label（text-xs text-muted-foreground）、value（text-sm font-medium + 状态圆点）、detail（text-xs text-muted-foreground）。
4. `StatusDot`：size-2 rounded-full，tone: good|warning|critical|idle；aria-hidden，并保证旁边有文字。
5. `InlineError`：shadcn Alert variant=destructive，简短中文。
6. `ConfirmDialog`：shadcn AlertDialog，危险操作（格式化、删除、重启、切换内核等）统一使用，按钮文案沿用现有。
7. `EmptyState`：图标 + 一句说明 + 可选操作按钮。
8. 加载：首屏用 Skeleton（与最终布局同形），不用纯文字「正在读取…」以外的转圈全屏。现有「正在读取…」文案保留在 Skeleton 的 sr-only 中。

## 状态管理（zustand）
- `useSessionStore`：登录/账户。
- `useStatusStore`：概览状态轮询、stale 标志、最后更新时间。
- `useActionStore`：取代 `run(label, action, done)`：同一时间一个阻塞动作；调用 `toast.promise`（进行中=label，成功=done，失败=错误文案）；暴露 busy。
- `usePassthroughStore`：透传状态（供侧栏 navHint 与 HDMI 输出页共享）。
- 轮询逻辑与超时、AbortController 语义保持现状（逐行迁移，不改行为）。

## 文案
所有中文文案、状态表、错误前缀保持现有字符串不变（它们已审过）。任何文案改动先列出给我审。

## 交付流程
- 工作目录：worktree `~/Developer/github/localhost-copilot/vim4-manager-ui`（分支 `ui/shadcn-refactor`，基于 origin/main）。项目规范文档在 `~/Developer/github/localhost-copilot/vim4-kvm/`（AGENTS.md、LESSONS.md、docs/code-standards.md、docs/subsystems/application.md）。
- 分阶段，小提交：
  - **阶段 1**：基础设施（Tailwind、shadcn 初始化、令牌、深色、Toaster、zustand store、共享组件、应用外壳：侧栏/手机顶栏/Sheet/页头）+ 迁移「概览」与「HDMI 输出」两页。停下来交截图给我审。
  - 阶段 2：其余页面（按 视频输入 → 虚拟介质 → 数据盘 → 网络存储 → KVM 界面 → 网络 → 散热 → 底层服务 → 更新 → 账户/登录）。
  - 阶段 3：删除 styles.css 与 Icons.tsx，体积与可访问性收尾。
- 截图：用现有 `web/tests/*.mjs` 的 mock/fixture 或 Vite dev + 拦截 API 的 mock，Playwright（Chromium）对每个迁移页面截：浅色/深色 × 1280px/390px；状态多的页面（HDMI 输出）每个关键状态各一组。存 `docs/ui-refactor/screens/<阶段>/`，同时截一组**重构前**同页对照（从 origin/main 构建）。
- 验证：`npm run typecheck`、`npm run build`、现有 `web/tests/*.mjs` 全部通过（选择器改为 role/label，不依赖旧类名）；Go 侧 `go build ./... && go test ./...`；报告打包体积前后对比。
- 不部署到板子，不推送 main；分支可推送到 origin。
