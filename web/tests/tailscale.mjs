import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  const online = {
    installed: true,
    running: true,
    backendState: "Running",
    hostName: "vim4",
    dnsName: "vim4.tail1234.ts.net",
    ips: ["100.64.0.7", "fd7a:115c:a1e0::7"],
    tailnet: "user@example.com",
    controlURL: "https://controlplane.tailscale.com",
    version: "1.104.0",
    peers: 3,
    peersOnline: 2,
    devices: [
      { id: "a", hostName: "macbook", dnsName: "macbook.tail1234.ts.net", os: "macOS", ips: ["100.64.0.2", "fd7a:115c:a1e0::2"], online: true, lastSeen: "", curAddr: "192.168.1.5:41641", relay: "sin", exitNode: false, active: true },
      { id: "b", hostName: "phone", dnsName: "phone.tail1234.ts.net", os: "android", ips: ["100.64.0.3"], online: true, lastSeen: "", curAddr: "", relay: "hkg", exitNode: false, active: false },
      { id: "c", hostName: "nas", dnsName: "nas.tail1234.ts.net", os: "linux", ips: ["100.64.0.4"], online: false, lastSeen: new Date(Date.now() - 3 * 86400000).toISOString(), curAddr: "", relay: "", exitNode: false, active: false },
    ],
  };
  const pings = {
    "100.64.0.2": { reachable: true, path: "direct", via: "192.168.1.5:41641", latencyMs: [1.2, 0.9, 1.1, 1.0], lost: 0, sent: 4 },
    "100.64.0.3": { reachable: true, path: "derp", via: "hkg", latencyMs: [48, 52, 50], lost: 1, sent: 4 },
    "100.64.0.4": { reachable: false, path: "", via: "", latencyMs: [], lost: 4, sent: 4 },
  };
  const pinged = [];
  await page.route("**/api/tailscale/ping", async (route) => {
    const { ip } = route.request().postDataJSON();
    pinged.push(ip);
    await new Promise((r) => setTimeout(r, 200));
    return route.fulfill({ json: pings[ip] });
  });
  let state = { installed: false };
  let failWrite = false;
  const writes = [];
  await page.route("**/api/tailscale", async (route) => {
    if (route.request().method() === "POST") {
      const data = route.request().postDataJSON();
      writes.push(data);
      if (failWrite)
        return route.fulfill({ status: 500, json: { error: "操作失败" } });
      switch (data.action) {
        case "install":
          state = { installed: true, running: true, backendState: "NeedsLogin" };
          break;
        case "login":
          state = { ...state, authURL: `${data.controlURL}/a/xyz` };
          return route.fulfill({ json: { authURL: state.authURL } });
        case "down":
          state = { ...state, backendState: "Stopped" };
          break;
        case "up":
          state = { ...state, backendState: "Running" };
          break;
        case "logout":
          state = { installed: true, running: true, backendState: "NeedsLogin" };
          break;
        case "uninstall":
          state = { installed: false };
          break;
      }
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: state });
  });
  const url = `${process.env.TEST_URL || "http://127.0.0.1:5188"}/tests/tailscale.html`;
  const status = page.getByRole("status");
  await page.goto(url);
  await status.getByText("未安装").waitFor();
  assert.deepEqual(writes, [], "reading state must not change Tailscale");

  await page.getByRole("button", { name: "安装 Tailscale" }).click();
  await status.getByText("未登录").waitFor();

  await page.getByRole("button", { name: /自建/ }).click();
  const input = page.getByRole("textbox", { name: "控制服务器地址" });
  await input.fill("https://hs.example.com/path");
  assert(await page.getByRole("button", { name: "获取登录链接" }).isDisabled());
  await input.fill("https://hs.example.com:8443");
  await page.getByRole("button", { name: "获取登录链接" }).click();
  const login = page.getByRole("link", { name: "打开登录页面" });
  await login.waitFor();
  assert.equal(await login.getAttribute("href"), "https://hs.example.com:8443/a/xyz");
  assert.deepEqual(writes.at(-1), { action: "login", controlURL: "https://hs.example.com:8443" });

  state = { ...online, controlURL: "https://hs.example.com:8443" };
  await status.getByText("已连接").waitFor();
  await page.getByRole("link", { name: "http://100.64.0.7:8080" }).waitFor();
  await page.getByRole("link", { name: "http://vim4.tail1234.ts.net:8080" }).waitFor();
  await page.getByRole("link", { name: "http://100.64.0.7", exact: true }).waitFor();
  await page.getByText("2 台在线 / 共 3 台").waitFor();
  assert.equal(await page.getByText("nas", { exact: true }).count(), 0, "offline devices start collapsed");

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "复制macbook 的地址" }).click();
  await page.getByRole("button", { name: "复制macbook 的地址" }).getByText("已复制").waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "100.64.0.2");

  await page.getByRole("button", { name: "测试到 macbook 的连接" }).click();
  await page.getByText("直连，1.1 ms").waitFor();
  await page.getByRole("button", { name: "测试到 phone 的连接" }).click();
  await page.getByText(/经 DERP 中继 hkg，50 ms，丢失 1\/4/).waitFor();
  await page.getByRole("button", { name: "显示 1 台离线设备" }).click();
  await page.getByText("3 天前在线").waitFor();
  await page.getByRole("button", { name: "测试到 nas 的连接" }).click();
  await page.getByText("无响应（4 次全部超时）").waitFor();
  assert.deepEqual(pinged, ["100.64.0.2", "100.64.0.3", "100.64.0.4"]);
  assert.equal(await login.count(), 0, "connected state must not show the stale login link");

  const toggle = page.getByRole("switch", { name: "Tailscale 连接" });
  await toggle.click();
  assert.equal(writes.at(-1).action, "login", "disconnect must await confirmation");
  await page.getByRole("alertdialog").getByRole("button", { name: "取消" }).click();
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await toggle.click();
  await page.getByRole("alertdialog").getByRole("button", { name: "断开", exact: true }).click();
  await status.getByText("已断开").waitFor();
  assert.equal(writes.at(-1).confirmed, true);
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  await toggle.click();
  await status.getByText("已连接").waitFor();

  await page.getByRole("button", { name: "切换控制服务器" }).click();
  await page.getByRole("textbox", { name: "控制服务器地址" }).fill("https://new.example");
  await page.getByRole("button", { name: "获取登录链接" }).click();
  await page.getByRole("alertdialog", { name: "切换控制服务器" }).waitFor();
  assert.equal(writes.at(-1).action, "up", "server change must await confirmation");
  await page.getByRole("alertdialog").getByRole("button", { name: "确认切换" }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  assert.deepEqual(writes.at(-1), { action: "login", controlURL: "https://new.example", previousControlURL: "https://hs.example.com:8443", confirmed: true });

  await page.getByRole("button", { name: "退出登录" }).click();
  await page.getByRole("button", { name: "取消" }).click();
  assert.equal(writes.at(-1).action, "login", "cancelling must not log out");
  await page.getByRole("button", { name: "退出登录" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "退出登录" }).click();
  await status.getByText("未登录").waitFor();

  failWrite = true;
  await page.getByRole("button", { name: "获取登录链接" }).click();
  await page.getByText("操作失败").waitFor();
  failWrite = false;

  state = { installed: true, running: true, backendState: "NeedsLogin", authURL: "javascript:alert(1)" };
  await page.reload();
  await status.getByText("未登录").waitFor();
  assert.equal(await page.getByRole("link", { name: "打开登录页面" }).count(), 0);
  await page.getByRole("button", { name: "获取登录链接" }).waitFor();

  state = { ...online, writable: true };
  await page.reload();
  await status.getByText("已连接").waitFor();
  assert(await toggle.isEnabled());
  assert(await page.getByRole("button", { name: "测试到 macbook 的连接" }).isEnabled());

  state = { installed: true, job: { action: "uninstall", running: true } };
  await status.getByText("正在卸载 Tailscale…").waitFor();
  assert.equal(await page.getByRole("button", { name: "卸载" }).count(), 0);
  state = { installed: false, job: { action: "install", running: false, error: "无法下载软件源密钥" } };
  await page.getByText("无法下载软件源密钥").waitFor();

  state = { ...online, authURL: "javascript:alert(1)" };
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();
    await status.getByText("已连接").waitFor();
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    );
    await page.screenshot({ path: `/tmp/manager-tailscale-${colorScheme}.png`, fullPage: true });
  }
  console.log(
    "Tailscale UI checks passed: install, Headscale, safe login links, disconnect and server-switch confirmation, remote read-only state, logout confirmation, failure, background job, access URLs, copy, device list, ping direct/DERP/timeout, mobile light/dark.",
  );
} finally {
  await browser.close();
}
