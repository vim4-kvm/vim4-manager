# vim4-manager

VIM4 KVM 管理面板，统一登录、选择 KVM 应用并维护板级设备。
开发先读[结构](#结构)与[构建与验证](#构建与验证)，改文案再读[本地化](docs/i18n.md#catalogs-and-formatting)。
页面行为只读下面对应文档；参数、接口和默认值以链接的源码为准。

## 开发导航

| 页面或任务 | 文档 |
|---|---|
| 概览、资源与连接状态 | [概览](docs/overview.md) |
| KVM 界面与切换 | [应用](docs/applications.md) |
| 虚拟介质 | [介质](docs/media.md) |
| 数据盘 | [数据盘](docs/disks.md) |
| 网络存储、NAS 文件夹 U 盘 | [网络存储](docs/storage.md) |
| 视频输入、EDID、HDR | [视频输入](docs/video.md) |
| HDMI 输出与本地声音 | [输出](docs/output.md) |
| 散热 | [散热](docs/cooling.md) |
| 网络 | [Wi-Fi](docs/wifi.md)、[Tailscale](docs/tailscale.md) |
| 底层服务 | [服务](docs/services.md) |
| 更新、内核切换 | [更新](docs/updates.md) |
| 账户、HTTPS、KVM 网关 | [账户](docs/auth.md) |
| 前端文案、术语与语言扩展 | [本地化](docs/i18n.md) |

## 结构

入口在 [main](cmd/vim4-manager/main.go)，嵌入构建后的前端。
[board](internal/board) 管设备读数和操作策略，[web](internal/web) 管认证后的 API；
特权写操作交给固定操作的 [helper](deploy/vim4-manager-helper)，授权见 [sudoers](deploy/vim4-manager-helper.sudoers)。
监听地址和启动参数只查入口的 flag 定义或程序帮助，安装身份与权限查[服务单元](deploy/vim4-manager.service)。

前端从 [App](web/src/App.tsx) 和[路由](web/src/shell/routes.tsx) 进入，页面在 [pages](web/src/pages)，
跨页面状态由 [stores](web/src/stores) 管理，请求类型集中于 [api.ts](web/src/api.ts)。
新界面复用 [components](web/src/components)、[主题](web/src/theme.tsx)和[样式令牌](web/src/index.css)。
按页加载、轮询随页面生命周期停止，标签页隐藏时暂停、显示后立即刷新；读取失败保留旧数据并明确标旧，不将缺失数据补零。
文案遵循[i18n](docs/i18n.md#catalogs-and-formatting)，不要在模块初始化时缓存翻译结果。

板级 HDMI、USB gadget、PD 和时钟由公共服务维护，各 KVM 应用互斥使用共享硬件。
供电状态优先使用板级模块返回的`kernelPD`实时合同；内核管理期间的未知/未确认状态
不会回退到固件或历史合同；cmdline屏蔽fusb302时只展示固件开机交接。供电额度不是功耗实测。升级须先安装含`kernel_power`的
公共`vim4pd`模块，再安装管理器；旧板级模块继续提供旧开机记录，查询不触发协商。
跨仓库边界见[应用子系统](https://github.com/vim4-kvm/vim4-kvm/blob/main/docs/subsystems/application.md)。
界面采用的上游资源保留[许可证](LICENSES/shadcn-admin.txt)；已完成的设计与截图见[归档](docs/archive/ui-refactor/README.md)。

## 构建与验证

本地先按[前端脚本](web/package.json)安装锁定依赖并构建，再运行 Go 和助手检查：

```sh
pnpm --dir web install --frozen-lockfile
pnpm --dir web build
go test ./...
go build ./...
python3 -m unittest discover -s deploy -p 'test_*.py'
```

助手测试依赖公共仓库的 board 模块；独立 worktree 缺少相邻模块时，使用临时目录重建约定布局。
真实 FAT 回归需要 Linux、mtools 和 dosfstools，Mac 的跳过不算通过。
前端预览用 `pnpm --dir web dev`；代理目标与覆盖方式查 [Vite 配置](web/vite.config.ts)。
浏览器回归从 [web/tests](web/tests) 选对应页面入口，先读脚本头部的环境与 fixture 要求；
fixture 验证不能替代实板。文案改动另跑 [i18n-source](web/tests/i18n-source.mjs) 和相应语言行为检查。

正式组件构建、打包与部署由[工作区工具](https://github.com/vim4-kvm/vim4-kvm/blob/main/docs/tools.md)完成，
发布按[Ubuntu 构建说明](https://github.com/vim4-kvm/vim4-kvm/blob/main/docs/ubuntu-build.md)。
板端操作遵循[公共规范](https://github.com/vim4-kvm/vim4-kvm/blob/main/docs/code-standards.md)；
历史验收只证明记录中的配置。
