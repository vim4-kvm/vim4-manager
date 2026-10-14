# Wi-Fi 开关

管理面板的“网络”区域控制 NetworkManager 的 Wi-Fi 总开关，与 KVM 应用选择无关。
状态每 3 秒读取一次，切换后以系统实际状态更新。关闭前提示无线会话会断开；
无线硬件禁用、没有网卡或读取失败时不允许切换。

`GET /api/wifi` 返回 supported、enabled（软件无线开关）、hardwareEnabled；
`POST /api/wifi` 接受 `{"enabled": true|false}`，沿用 JSON 请求限制和串行操作锁。
助手固定操作为 `wifi on|off`，开启时同时恢复主无线接口，避免 VIM4 上开关已启用
但接口 DOWN 导致扫描空列表。Wi-Fi 开关由 NetworkManager 保存；不修改网络密码。

验证：运行 README 的构建及 Go/Python 测试后，启动 `pnpm --dir web dev --port 5188`，
运行 `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node web/tests/wifi.mjs`。
浏览器测试使用模拟 API，不切换实际无线网络。
