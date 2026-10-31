# 去模板化打磨（unslop）

依据 [heydamir/unslop](https://github.com/heydamir/unslop)（Damir Sokolovsky，CC BY 4.0）的审计规则，
在 [shadcn-admin 适配](shadcn-admin.md) 之上做一轮打磨。功能、接口、轮询、文案含义和页面顺序不变；
改变的是颜色、字重、强调色用法、概览布局和一个贯穿全站的端口标签细节。

## 方向

- 产品：一块接在目标电脑旁的 KVM 板，管理员在这里看信号、供电与 USB，并切换 KVM 界面。
- 气质：精确、硬件感、安静。
- 场景：机柜、丝印、接口标签。表面是中性石墨灰，唯一强调色是现有品牌蓝。
- 重点画面：① 概览首屏的板子实拍与端口状态；② 一张认真画的主趋势图。
- 标志细节：丝印式端口标签（`HDMI IN`、`HDMI OUT`、`USB-C`），只用于指代实体端口的地方。

## 审计结论（打磨前）

代码层无紫蓝渐变、发光、emoji、全大写追踪标签、循环装饰动画。问题集中在：
深色底偏藏青（Slate）；绿色状态点一屏十余个；选中态用蓝边蓝底；标题 700 字重且小字收紧字距；
单句说明带句号；面包屑与 H1 重复；概览四张同构卡片带角标图标、趋势图被撑出约 100px 空带、
信号路径藏在折叠里；温度在侧栏为 `52°`、其他处为 `52.4 °C`；`text-[11px]` 等非刻度字号；
组件库 `transition-all` 与布局弹簧。

## 颜色令牌

深色（`.dark`）：

| 令牌 | 值 |
|---|---|
| background | `#141415` |
| card | `#19191b` |
| popover | `#1d1d1f` |
| sidebar | `#0f0f10` |
| muted / accent / secondary | `#232325` |
| foreground / card-foreground / popover-foreground / accent-foreground | `#ededed` |
| secondary-foreground | `#a1a1a6` |
| muted-foreground | `#8b8b91` |
| border / sidebar-border | `rgb(237 237 237 / 8%)` |
| input | `rgb(237 237 237 / 14%)` |
| primary / primary-fill | `#ededed`，前景 `#141415` |

浅色（`:root`）：

| 令牌 | 值 |
|---|---|
| background | `#fafafa` |
| card / popover | `#ffffff` |
| sidebar | `#f5f5f6` |
| muted / accent / secondary | `#f4f4f5` |
| foreground 系列 | `#171717` |
| secondary-foreground | `#525252` |
| muted-foreground | `#6b6b70` |
| border / sidebar-border | `rgb(23 23 23 / 9%)` |
| input | `rgb(23 23 23 / 16%)` |
| primary / primary-fill | `#171717`，前景 `#ffffff` |

`--link`、`--chart-1`（品牌蓝）、success / warning / destructive / idle 保持现值；
`--ring` 取 link 色。所有文字与其表面对比度不低于 4.5:1（muted 文字在 muted 表面上也须满足）。

## 强调色与状态点

- 蓝色只用于：链接、开关/单选的选中态、焦点环、图表主序列、进度条，以及信号路径图的视频连线和端口标记。信号路径图保留视频 link 蓝、网络中性、USB 数据原青色、供电原琥珀色。卡片边框和底色不用蓝。
- 选中卡片（KVM 应用、EDID 预设）：`bg-muted/50` + `border-foreground/15`，不用蓝边蓝底。
- 页面顶部状态条一律为中性卡片，不再有绿色底（KVM 页「当前运行」条）。
- 绿色圆点只出现在：各页顶部状态条的首个状态标签、当前 KVM 的「运行中」、信号路径图的端口节点与节点卡片状态标签。
  其他位置（侧栏提示、概览数值、设备健康、网卡列表）good 不画点，只显示文字；
  warning / critical 照旧画彩色点并着色文字；idle 画中性点；概览虚拟介质未挂载时不画点，数值使用 muted-foreground。
- 最近事件：good 与 idle 用中性点（`bg-muted-foreground/40`），warning / critical 用彩色点。
- 侧栏提示文字为 `text-muted-foreground tabular-nums`；仅 warning / critical 时带点并着色。

## 字体

- 去掉全部 `tracking-tight`；去掉全部 `font-bold`。
- H1：`text-2xl md:text-3xl font-medium`。卡片标题、应用名、介质名：`font-medium`。
- 数值：概览数值 `text-lg font-medium tabular-nums`，趋势当前值 `text-3xl font-medium tabular-nums`。
  其余 `font-semibold` 改为 `font-medium`；600 字重不再使用。
- `text-[11px]`、`text-[11.5px]` 改为 `text-xs`。
- 温度全站用 `celsius()` 同一格式（含侧栏提示）。

## 文案

- 单句的页面说明、卡片说明、设置行说明、脚注：英文去掉句末句号，中文去掉句末「。」。
  两句及以上的段落保留标点。中英文同步。
- 桌面顶栏去掉面包屑；手机顶栏保留当前页标题。
- KVM 页应用卡片：版本未知时不显示「Version」行，不显示 `Unknown`。

## 端口标签 `PortTag`

新组件：`inline-flex h-5 items-center rounded-[4px] border bg-muted px-1.5 font-mono text-xs font-medium leading-none text-foreground/80`，
内容为丝印原文（`HDMI IN`、`HDMI OUT`、`USB-C`），不翻译。信号路径图上的端口标签改用同一组件。
只出现在：信号路径图端口、
视频输入页状态条首位（`HDMI IN`）、HDMI 输出页「输出设置」卡片标题旁（`HDMI OUT`）。

## 概览布局

容器 ≥ `@4xl`：

```
┌ 概览 ─────────────────────────────────────── ● 自动刷新 [↻] ┐
├──────────────────────────────────────┬─────────────────────┤
│ ● 设备在线  vim4 · 192.168.50.210 · 运行 3 天   HDMI 输出 ↗ │ 当前 KVM             │
│                                      │ One-KVM ● 运行中     │
│        [ 板子实拍 + 端口标签/标记 ]     │ [ 打开 One-KVM ↗ ]   │
│                                      │ 切换 KVM 界面         │
├──────────┬──────────┬──────────┬─────┤─────────────────────┤
│HDMI 输入 │USB 输入  │USB-C 供电│介质 │ 最近事件              │
│3840×2160 │已连接    │12 V / 3 A│未挂载│ …                   │
└──────────┴──────────┴──────────┴─────┴─────────────────────┘
┌ 资源趋势（整行，图高 240px）──────────────────────────────────┐
┌ 设备健康（整行，温度/风扇/内存/系统盘/网络 五列同一网格）──────┐
```

- 原顶部状态条与四张数值卡合并为「板卡」卡片，占左两列：
  - 头部：原状态标签及逻辑、主机名、IPv4（mono）、运行时长；右侧「查看 HDMI 输出」链接。
  - 主体：`DeviceConnections` 新增 `compact` 变体，只显示板子实拍、端口标记与 `PortTag`，
    不显示四个节点卡片和连线；点选端口仍打开现有详情。板图在剩余空间内垂直居中、桌面最高 300px，填满卡片剩余高度。
  - 底部：四格数值条，`grid-cols-4 divide-x border-t`。每格：标签（`text-xs muted`）、
    数值、详情（`text-xs muted`）。标签、数值、详情三条基线对齐，不再显示 PortTag；去掉角标图标和右箭头；整格可点击跳转，悬停 `bg-muted/50`，有焦点环。
    USB-C 供电格保留源能力展开明细。
- 右列：当前 KVM（去掉 `size-8` 装饰图标）+ 最近事件；左卡 `h-full`，右列第二张卡填满剩余高度，不留空带。
- 资源趋势占整行，绘图区高 240px（窄屏 180px），按峰值生成整齐等距刻度，非零峰值至少占绘图区高度的 60%（23% 对应 0/10/20/30%），缺失数据不补零。
  桌面标题、指标页签、时间范围同一行；下一行当前值块靠左，平均/峰值/最小值靠右。
  窄屏页签独占一行并可横向滚动，统计位于当前值下方；采样脚注保留在图下方。
- 设备健康：五项在同一网格对齐；网卡名称与速率在同一行（Ethernet eth0 · 1 Gbps），地址在下一行，均左对齐。

窄屏（< `@4xl`）依次为：板卡卡片（板子图收进原「显示连接」折叠，数值条 2×2）、当前 KVM、资源趋势、
最近事件、设备健康。
窄屏板卡头部三行：状态 + 主机名 · IP、运行时长、左对齐的连接折叠按钮；HDMI 输出链接移入折叠面板。
2×2 数值条只画内部分隔线，外侧不重复描边。

## 其他页面

- KVM 界面：去掉应用卡片的图标方块；「开机启动」改为状态旁的 `text-xs muted` 文字，不用药丸；同一行卡片的元信息和操作区推到底部，Service 分隔线与按钮对齐。
- 视频输入：EDID 预设的「已保存」「已加载」改为名称后的 `text-xs muted` 文字，名称后间隔 8px；合为一段 Saved · Loaded（已保存 · 已加载），不加前导点。
- 侧栏底部主机名与内核版本左对齐；桌面顶栏删除侧栏按钮右侧的竖分隔线，手机保留。
- 徽章 `rounded-4xl` 改为 `rounded-md`。
- 品牌标志与登录页不改。

## 图标与动效

- `LucideProvider strokeWidth={1.5}`；行内图标统一 `size-4`。
- 唯一缓动 `cubic-bezier(0.22, 1, 0.36, 1)`（`lib/motion.ts` 的 enter 与 exit 共用）；
  `layoutSpring` 改为时长 0.3s 的同一缓动。
- `components/ui` 中 `transition-all` 改为明确属性（颜色、背景、边框、阴影、透明度、transform）。
- 骨架屏的 pulse 保留。

## 实现与验证

- 登录页只把三处标题字重由 600 改为 500，以满足全站不用 600 的约定；布局、品牌、文案与 1.75 图标描边不变。
  管理页图标描边为 1.5。
- 信号路径图的连线与端口按含义着色（视频蓝、网络中性、USB 青、供电琥珀），节点保留状态点；
  这是本页的重点画面，不受「强调色只用一种」的限制。
- 资源趋势坐标轴按峰值取整齐刻度（峰值 23% 时上限 30%），绘图区桌面 240px、窄屏 180px；
  平均、峰值、最小值放在当前值右侧。概览四格数值条不带 PortTag，端口标签只在板图上出现。
- 浏览器断言改为检查新结构，并增加板图尺寸、端口键盘详情和手机折叠检查。

离线验证（全部使用模拟 API，不连接板子）：`pnpm --dir web typecheck && pnpm --dir web build`、
全部 `web/tests/*.mjs`、`i18n-screens.mjs`（117 张，无文字溢出或按钮裁切）、deploy 与主仓库单元测试均通过；
上述禁用类名在 `web/src` 中无匹配。`go test ./...` 只有
`internal/nasdisk.TestNewSessionPersistsLayoutVersionAndDiscardRemovesDirectory` 失败，
原因是本机磁盘剩余 859 MiB，低于该测试要求的 2 GiB 预留加 256 MiB；本轮没有改动 Go 代码。
