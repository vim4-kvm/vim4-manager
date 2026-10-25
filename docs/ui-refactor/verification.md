# 前端重构验收记录

分支：`ui/shadcn-refactor`。比较基线：`origin/main` 的 `fa088412c73c767a919441d96d4f9f6f9a31b12d`。
代码完成提交：`2def1d4`。源码提交依次为 `ec11ec1`（基础设施/概览/输出）、`154330d`（视频输入）、`89a3549`（介质/数据盘/NAS）、`87642fa`（页面拆分/网络/散热/更新）、`6e95988`（账户/登录）、`2def1d4`（清理与回归收尾）。截图与本记录另作验收提交。

仅在独立 worktree 和本机临时目录构建、验证；未合入 main、未部署、未 SSH 到板子。

## 阶段与行为

- 阶段 1：审查并接续现有未提交改动，完成 Tailwind v4、shadcn Nova、四个 zustand store、共享组件、桌面侧栏与手机 Sheet；完成概览和 HDMI 输出。
- 阶段 2：完成视频输入、虚拟介质、数据盘、网络存储、KVM 界面、网络、散热、底层服务、更新、账户和独立登录页，含 `login.html`。
- 阶段 3：删除 `styles.css`、`Icons.tsx` 及旧账户图标、旧主题控件和旧开发版标签入口。唯一自定义样式文件 `web/src/index.css` 为 **142 行**；没有组件 CSS，源码中的内联样式仅用于图表坐标、HDR 灰阶及进度百分比。

`App.tsx` 只负责路由与状态轮询入口，各页面从 zustand 读取共享状态。卡片、设置行、事实栏、状态点、错误、确认框、空状态、Skeleton 和动态列表均使用共享组件。密码输入、复制和二维码也集中复用。

透传的请求、超时、`readStale` 锁定、HDR 行状态表及失败文案过滤逐项保留；`web/src/api.ts` 没有变动。保留虚拟介质安全弹出、五分钟等待与取消、文件上传离页保护、NAS 回写及原轮询时限。

额外修复了迁移中实际复现的数据盘读取问题：LUN token 变化会中止前一次请求，而共享 request helper 的 JSON 解码回退可能产生空对象。已中止的结果现在不会回写磁盘列表。`controls.mjs` 用受控的解码中止覆盖该回归。

Motion 令牌集中于 `lib/motion.ts`，页面使用 `AnimatePresence mode="wait"`；未变的轮询文字保持相同节点。全局 `LazyMotion` 使用 `domAnimation`，只有共享 `AnimatedList` 按需加载包含布局能力的 `domMax`。对话框、Sheet、菜单与 toast 沿用各自原语动画。

## 验证

环境：Node 24.19.0、pnpm 12.4.1、Vite 8.3.4、本机 Chrome / Playwright；所有浏览器请求均由本地 fixture 拦截。

- `pnpm --dir web install --frozen-lockfile`、`typecheck`、`build` 通过。
- `web/tests/*.mjs` 全部 18 个入口通过：14 个行为回归、2 个 fixture 入口、2 个截图入口。账户与登录包含 22 个场景。
- 新增 `controls.mjs` 覆盖中止读取、EDID 确认、HDR 键盘预览/保存、风扇输入边界和服务重启确认；`motion.mjs` 覆盖未变轮询、文字变化、页面等待切换、离页停止轮询、列表布局与增删、减少动态效果。
- 原测试已改用角色、标签和命名区域；图表与样式检查保留语义数据标记。定时器测试在断言窗口外恢复时钟，避免把 Radix 的异步焦点恢复或截图动画当作同步行为。
- 根目录 `go build ./...`、`go test ./...` 通过。
- README 的 Python helper 回归：独立 worktree 直接运行会缺少约定的相邻 `../board` 模块。将当前 `deploy/` 和相邻主仓库的 `board/vim4*.py` 复制到 `/tmp/vim4-refactor-validation/{vim4-manager/deploy,board}` 的既定布局后，**207 项通过，12 项依环境跳过**。未修改原 checkout 或部署文件。

## 打包体积

同机、相同构建工具，比较整个 `web/dist`，包含登录入口和按需加载的布局动画 chunk。gzip 为各文件单独压缩后求和，单位为十进制 kB；精确字节见 [bundle-size.json](bundle-size.json)。

| 产物 | 重构前 | 重构后 | 前 gzip | 后 gzip |
|---|---:|---:|---:|---:|
| JavaScript | 435.4 | 807.1 | 134.3 | 254.6 |
| CSS | 73.9 | 96.9 | 13.8 | 16.4 |
| HTML | 1.5 | 2.0 | 0.8 | 1.1 |
| 合计 | **510.9** | **906.0** | **148.9** | **272.1** |

新增组件和动画栈使总产物增加约 77.3%，gzip 增加约 82.7%。这些数字没有用源码 CSS 行数下降代替实际包体，也没有省略按需 chunk。

## 截图

每个状态均有浅/深色 × 1280/390，使用同一组 mock 比较原始 UI 和最终 UI。原始 `web/src` 已与 `origin/main` 完整比对；未使用原 checkout。

| 目录 | before | after | 内容 |
|---|---:|---:|---|
| [phase1](screens/phase1/) | 68 | 70 | 概览、15 种 HDMI 状态与保存失败；after 另含手机 Sheet |
| [phase2](screens/phase2/) | 220 | 220 | 其余全部页面和主要加载失败、编辑、确认、NAS 回写等状态 |
| [phase3](screens/phase3/) | 64 | 64 | 全页最终对照，另含 HDMI 陈旧读取锁定、HDR 请求处理中、删除确认 |

合计 **706 张**。各目录的 `manifest.json` 列出对应文件；`ui-screens.mjs`、`ui-pages.mjs` 可复现矩阵。

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node web/tests/ui-screens.mjs http://127.0.0.1:5188 docs/ui-refactor/screens/phase1/after --after
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node web/tests/ui-pages.mjs http://127.0.0.1:5188 docs/ui-refactor/screens/phase2/after --after
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node web/tests/ui-pages.mjs http://127.0.0.1:5188 docs/ui-refactor/screens/phase3/after --after --phase3
```

## 文案与待审项

原中文字符串、模板片段及 JSX 文本审计没有发现删除或改写；状态与失败文案另有浏览器断言。新增文字仅为无障碍区域名称：`当前状态`、`打开菜单`、`通知`、`U 盘`、`上次`。没有业务文案变更建议。

**保留批准配色的对比度例外**：主按钮白字配浅色 `#006fff` 约 4.48:1，配深色 `#3d8bff` 约 3.31:1，与旧测试的 4.5:1 门槛冲突。本轮遵守已批准 token，没有自行改色；该类主按钮的测试显式记录 3:1 例外，其他文字继续按原门槛检查。交由后续 Claude 整体审美调整时处理，不能据此宣称所有小字均满足 AA。
