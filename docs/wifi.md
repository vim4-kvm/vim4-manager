# Wi-Fi 管理与热点

管理面板的“网络”页管理整机无线网络，与 KVM 应用选择无关。主无线接口（第一个
NetworkManager wifi 设备，VIM4 上为 wlan0）有两种互斥模式：

- **客户端**：扫描并连接周围网络，管理已保存的网络。
- **热点**：板子发出 WPA2 网络，其他主机直接连入访问管理面板（80）和 KVM（8080）。

Wi-Fi 总开关仍是最高层：关闭后两种模式都停止。有线网络不受影响。
全部基于 NetworkManager（1.46，已带 dnsmasq-base），通过板上已有的 python3-dbus
调用 Settings 接口持久保存配置（netplan 插件写入 /etc/netplan），不引入 hostapd 服务。

## 热点

- 固定连接名 `vim4-hotspot`，绑定主接口，`802-11-wireless.mode ap`，`band bg`，
  WPA2-PSK（`proto rsn`、`pairwise ccmp`），`ipv4.method shared`、`ipv6.method disabled`。
  NetworkManager 自动提供 DHCP/DNS，板子地址默认 `10.42.0.1/24`；共享模式会让连入的主机
  经有线网络上网。
- 默认名称 `VIM4-KVM-XXXX`（主接口 MAC 后两字节大写十六进制）；首次开启时若未设置密码，
  助手生成 12 位随机密码（排除 0/O/1/l/I）。不提供开放热点。
- `autostart` 对应连接的 autoconnect，并设 `autoconnect-priority 100`；开启后开机即进入
  热点模式。切回客户端模式时热点 autoconnect 置 no，保留配置。
- VIM4 驱动只报告 2.4 GHz AP 能力，信道 0（自动）或 1–11。
- 连入设备由 `iw dev IFACE station dump` 与 NetworkManager 的 dnsmasq 租约文件合并得到。
- 热点运行时，名称旁的二维码按钮弹出三个码：标准 `WIFI:T:WPA;S:…;P:…;;` 连接码（UTF-8，
  按 ZXing 约定转义 `\ ; , : "`），以及管理面板和 KVM 界面地址。二维码在浏览器本地生成，不需外网。
  二维码与「显示密码」一样暴露密码，面板仍面向可信局域网。

## 模式切换与回退

- 切换会断开主接口上的现有无线连接。请求若经无线接口到达（`viaWifi`），页面额外提示
  当前会话会断开、以及之后应访问的地址。
- 客户端 → 热点：启动失败时恢复原来活动的客户端连接，返回错误。
- 热点 → 客户端：停止热点后让 NetworkManager 自动连接已保存网络；30 秒内没有连上
  （或没有已保存网络）则重新开启热点并返回错误，避免板子在无人值守时失去无线入口。
  `force: true` 跳过此回退（明确接受断开）。网页只在请求经无线到达且有已保存网络时使用回退，
  其他情况（经有线访问或没有已保存网络）直接切换，以便切换后扫描并选择网络。
- 连接新网络失败（密码错误、找不到网络、超时 45 秒）时删除本次新建的连接，恢复之前的
  活动连接或热点，保留已有的同名保存连接。

## API

所有写请求沿用 JSON 限制、Host/Origin 检查、Tailscale 只读和串行操作锁（忙时 409）。
密码只经助手标准输入传递，不出现在命令行参数和日志中。

### `GET /api/wifi`

```json
{
  "supported": true, "enabled": true, "hardwareEnabled": true,
  "device": "wlan0",
  "mode": "client",
  "state": "connected",
  "viaWifi": false,
  "current": {"id": "uuid", "ssid": "Home", "signal": 72, "security": "WPA2",
              "frequency": 2437, "ipv4": "192.168.1.20/24"},
  "saved": [{"id": "uuid", "ssid": "Home", "autoconnect": true, "active": true}],
  "hotspot": {"configured": true, "active": false, "ssid": "VIM4-KVM-BC28",
              "password": "…", "channel": 0, "autostart": false,
              "address": "10.42.0.1/24", "clients": [{"mac": "…", "ip": "10.42.0.23", "hostname": "mac"}]}
}
```

- `mode`：`client|hotspot|off`（总开关关闭或硬件禁用为 off）。
- `state`：主接口状态 `connected|connecting|disconnected|unavailable`。
- `current`：客户端模式下的活动连接，否则 null；`saved` 不含 `vim4-hotspot`。
- `hotspot.password` 在未配置时为空串，`ssid` 给出默认名称；`clients` 仅热点活动时非空。
- `supported=false` 时其余字段为零值。旧字段含义不变。

### `GET /api/wifi/networks?rescan=1`

`{"networks":[{"ssid","signal","security","frequency","saved","active"}]}`。按 SSID 去重保留最强
信号，按信号降序；隐藏网络（空 SSID）不列出。`security` 为空表示开放网络。热点模式或总开关
关闭时返回空列表。rescan 触发主动扫描（最长约 10 秒），省略时读取缓存结果。

### 写操作

| HTTP | 请求体 | 说明 |
|---|---|---|
| `POST /api/wifi` | `{enabled}` | 总开关，同旧版 |
| `POST /api/wifi/connect` | `{ssid,password,hidden}` | 新网络或更新已保存网络的密码；热点模式下自动切到客户端 |
| `POST /api/wifi/activate` | `{id}` | 连接已保存网络 |
| `POST /api/wifi/disconnect` | `{}` | 断开当前客户端连接（本次会话内不自动重连） |
| `POST /api/wifi/forget` | `{id}` | 删除已保存网络；活动时先断开 |
| `POST /api/wifi/autoconnect` | `{id,enabled}` | 设置已保存网络自动连接 |
| `POST /api/wifi/hotspot` | `{ssid,password,channel,autostart}` | 保存热点配置；热点活动时重新应用 |
| `POST /api/wifi/mode` | `{mode,force}` | `client|hotspot` 切换，见上文回退 |

校验：SSID 1–32 字节 UTF-8，无控制字符；客户端密码为空（开放网络）、8–63 位可打印 ASCII
或 64 位十六进制；热点密码 8–63 位可打印 ASCII，空串表示保留现有密码（未配置时生成）；
channel 为 0–11；id 为已保存的 wifi 连接 UUID。成功返回 `{ok:true}`，错误为中文 `{error}`。

## 助手操作

| 操作 | 说明 |
|---|---|
| `wifi on\|off` | 总开关，开启时恢复主接口 link |
| `wifi-status` | 输出上面 GET 的 JSON（不含 viaWifi），读取 PSK 需 root；不取操作锁 |
| `wifi-scan 0\|1` | 输出 networks JSON；不取操作锁 |
| `wifi-connect` | 标准输入 `{ssid,password,hidden}` |
| `wifi-activate UUID`、`wifi-disconnect`、`wifi-forget UUID`、`wifi-autoconnect UUID yes\|no` | 固定参数 |
| `wifi-hotspot` | 标准输入 `{ssid,password,channel,autostart}` |
| `wifi-mode client\|hotspot [force]` | 含回退逻辑 |

## 验证

运行 README 的构建及 Go/Python 测试后，启动 `pnpm --dir web dev --port 5188`，
运行 `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node web/tests/wifi.mjs`。
浏览器测试使用模拟 API，不切换实际无线网络。上板时经有线访问面板，验证热点开启后
`iw dev wlan0 info` 为 AP、关闭后回退逻辑生效。
