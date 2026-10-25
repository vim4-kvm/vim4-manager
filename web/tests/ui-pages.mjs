// Offline review matrix, identical API data and interactions on origin/main and the refactor.
// node web/tests/ui-pages.mjs <base-url> <output-dir> [--after] [--phase3]
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fixtures } from "./ui-fixtures.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const [base = "http://127.0.0.1:5188", out = "/tmp/ui-pages"] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const after = process.argv.includes("--after");
const click = (name) => (page) => page.getByRole("button", { name, exact: true }).click();
const change = (name, value) => (page) => page.getByLabel(name, { exact: true }).fill(value);
const scenarios = [
  { name: "video-synced", page: "video", ready: "所选预设已保存并加载。" },
  { name: "video-out-of-sync", page: "video", edit: (f) => { f.edid.jetkvmSynced = false; }, ready: "重新应用可同步 JetKVM 配置。" },
  { name: "video-edid-confirm", page: "video", ready: "所选预设已保存并加载。", actions: [async (p) => p.getByRole("radio", { name: /VIM4 1080p60/ }).check(), click("应用预设")] },
  { name: "video-read-error", page: "video", edit: (f) => { f.errors["/api/edid"] = "读取连接中断"; }, ready: "读取失败：读取连接中断" },
  { name: "media-empty", page: "media", ready: "未挂载介质" },
  { name: "media-mounted", page: "media", edit: (f) => { f.status.media.inserted = true; }, ready: "已挂载到被控电脑" },
  { name: "media-eject-confirm", page: "media", edit: (f) => { f.status.media.inserted = true; }, ready: "已挂载到被控电脑", actions: [click("弹出…")] },
  { name: "media-unknown", page: "media", edit: (f) => { f.status.media.known = false; }, ready: "状态未知" },
  { name: "disks-files", page: "disks", ready: "readme.txt" },
  { name: "disks-create", page: "disks", ready: "readme.txt", actions: [click("新建数据盘")] },
  { name: "disks-format-confirm", page: "disks", ready: "readme.txt", actions: [click("格式化…")] },
  { name: "disks-attached", page: "disks", edit: (f) => { f.disks[0].attached = true; }, ready: "数据盘正挂载在被控电脑上" },
  { name: "disks-empty", page: "disks", edit: (f) => { f.disks = []; }, ready: "还没有数据盘。" },
  { name: "disks-read-error", page: "disks", edit: (f) => { f.errors["/api/disks"] = "无法读取挂载状态"; }, ready: "无法读取挂载状态" },
  { name: "storage-connected", page: "storage", ready: "//192.168.50.2/video" },
  { name: "storage-empty", page: "storage", edit: (f) => { f.storage.storages = []; }, ready: "还没有 NAS" },
  { name: "storage-add", page: "storage", ready: "//192.168.50.2/video", actions: [click("添加 NAS")] },
  { name: "storage-folder", page: "storage", ready: "//192.168.50.2/video", actions: [click("作为 U 盘…")] },
  { name: "storage-read-only", page: "storage", edit: (f) => { f.storage.storages[0].writable = false; }, ready: "板子没有写入权限" },
  { name: "storage-stalled", page: "storage", edit: (f) => { f.storage.storages[0].stale = true; }, ready: "已连接 · 无响应" },
  ...["scanning", "attached", "committing", "needs-decision", "failed"].map((state) => ({
    name: `storage-usb-${state}`, page: "storage", ready: "U 盘 · 家庭 NAS", edit: (f) => {
      f.nasdisk.session = { ...f.nasSession, state,
        progress: state === "committing" ? { done: 3, total: 10, bytesDone: 2 ** 20, bytesTotal: 4 * 2 ** 20, current: "readme.txt" } : null,
        decision: state === "needs-decision" ? { reason: "文件系统不完整", canForce: true } : null,
        error: state === "failed" ? "NAS 连接中断" : "" };
    },
  })),
  { name: "apps-selected", page: "apps", ready: "开机启用" },
  { name: "apps-switch-confirm", page: "apps", ready: "开机启用", actions: [async (p) => p.getByRole("button", { name: "切换到此", exact: true }).last().click()] },
  { name: "apps-wait-for-eject", page: "apps", edit: (f) => { f.status.media.inserted = true; }, ready: "开机启用", actions: [async (p) => p.getByRole("button", { name: "切换到此", exact: true }).last().click(), click("弹出后继续切换")] },
  { name: "network-client", page: "network", ready: "Home" },
  { name: "network-join", page: "network", ready: "Office", actions: [async (p) => p.getByRole("button", { name: /Office/ }).click()] },
  { name: "network-hotspot", page: "network", ready: "正在广播", edit: (f) => { f.wifi.mode = "hotspot"; f.wifi.hotspot.active = true; } },
  { name: "network-hotspot-qr", page: "network", ready: "正在广播", edit: (f) => { f.wifi.mode = "hotspot"; f.wifi.hotspot.active = true; }, actions: [click("扫码连接热点")] },
  { name: "network-off", page: "network", edit: (f) => { f.wifi.enabled = false; f.wifi.mode = "off"; f.tailscale.installed = false; }, ready: "安装 Tailscale" },
  { name: "network-login", page: "network", edit: (f) => { f.tailscale.backendState = "NeedsLogin"; f.tailscale.authURL = "https://login.tailscale.com/a/example"; }, ready: "打开登录页面" },
  { name: "network-approval", page: "network", edit: (f) => { f.tailscale.backendState = "NeedsMachineAuth"; }, ready: "等待 tailnet 管理员" },
  { name: "network-installing", page: "network", edit: (f) => { f.tailscale.job = { action: "install", running: true }; }, ready: "正在安装 Tailscale…" },
  { name: "cooling-current", page: "cooling", ready: "起转温度" },
  { name: "cooling-draft", page: "cooling", ready: "起转温度", actions: [async (p) => p.getByRole("button", { name: /凉爽/ }).click()] },
  { name: "cooling-invalid", page: "cooling", ready: "起转温度", actions: [async (p) => p.getByRole("spinbutton", { name: /起转温度/ }).fill("90")] },
  { name: "services-running", page: "services", ready: "vim4-hdmi.service" },
  { name: "services-failed", page: "services", edit: (f) => { f.status.platform[0].unit.active = "failed"; }, ready: "vim4-hdmi.service" },
  { name: "updates-available", page: "updates", ready: "可更新到 1.4.1" },
  { name: "updates-install-confirm", page: "updates", ready: "可更新到 1.4.1", actions: [click("更新")] },
  { name: "updates-kernel-confirm", page: "updates", ready: "可更新到 1.4.1", actions: [click("切换并重启")] },
  { name: "account-devices", page: "account", ready: "本设备" },
  { name: "account-single", page: "account", edit: (f) => { f.account.sessions = f.account.sessions.slice(0, 1); }, ready: "仅本设备" },
  { name: "account-read-error", page: "account", edit: (f) => { f.errors["/api/account/sessions"] = "无法读取登录设备"; }, ready: "无法读取登录设备" },
  { name: "account-password", page: "account", ready: "本设备", actions: [click("修改密码")] },
  { name: "account-logout-others", page: "account", ready: "本设备", actions: [click("退出其他设备")] },
  { name: "login", page: "login", ready: "忘记密码？" },
  { name: "login-forgot", page: "login", ready: "忘记密码？", actions: [click("忘记密码？")] },
  { name: "login-error", page: "login", ready: "忘记密码？", actions: [change("密码", "wrong-password"), click("登录")] },
  { name: "login-setup", page: "login", edit: (f) => { f.auth.configured = false; }, ready: "创建管理员账户" },
  { name: "login-setup-blocked", page: "login", edit: (f) => { f.auth.configured = false; f.auth.setupAllowed = false; }, ready: "需要在局域网内完成设置" },
  { name: "login-load-error", page: "login", edit: (f) => { f.errors["/__vim4/api/auth/state"] = "offline"; }, ready: "无法连接板子，请检查网络后重试" },
];

const finalPageStates = new Set(["video-synced", "media-mounted", "disks-files", "storage-connected", "apps-selected", "network-client", "cooling-current", "services-running", "updates-available", "account-devices", "login"]);
const captureScenarios = process.argv.includes("--phase3") ? [
  { name: "overview-final", page: "overview", ready: "最近事件" },
  { name: "output-final", page: "output", ready: "透传中" },
  ...scenarios.filter((scenario) => finalPageStates.has(scenario.name)),
  { name: "output-read-stale", page: "output", ready: "透传中", actions: [async (p, f) => {
    f.errors["/api/passthrough"] = "读取连接中断";
    await p.getByText("刷新失败：读取连接中断，显示的是上次读取的状态。", { exact: true }).waitFor();
  }] },
  { name: "output-hdr-pending", page: "output", ready: "透传中", edit: (f) => { f.pendingWrite = true; },
    actions: [async (p) => { await p.getByRole("switch", { name: "HDR", exact: true }).click(); await p.getByText("正在切换…", { exact: true }).first().waitFor(); }] },
  { name: "disks-delete-confirm", page: "disks", ready: "readme.txt", actions: [async (p) => {
    await p.getByRole("button", { name: /^readme\.txt/ }).click();
    if (after && p.viewportSize().width < 768) {
      await p.getByRole("button", { name: "打开 readme.txt 操作菜单" }).click();
      await p.getByRole("menuitem", { name: "删除", exact: true }).click();
    } else await p.getByRole("button", { name: "删除 readme.txt", exact: true }).click();
    await p.getByRole("alertdialog").waitFor();
  }] },
  ...(after ? [{ name: "disks-file-actions", page: "disks", ready: "readme.txt", actions: [async (p) => {
    if (p.viewportSize().width < 768) await p.getByRole("button", { name: "打开 readme.txt 操作菜单" }).click();
    else await p.getByRole("button", { name: /^readme\.txt/ }).focus();
  }] }] : []),
] : scenarios;

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const captures = [];
try {
  for (const theme of ["light", "dark"]) for (const width of [1280, 390]) for (const scenario of captureScenarios) {
    if (process.env.SCREEN_FILTER && !scenario.name.includes(process.env.SCREEN_FILTER)) continue;
    const data = fixtures();
    scenario.edit?.(data);
    if (scenario.page === "login") data.auth.authenticated = false;
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: theme, reducedMotion: "reduce", locale: "zh-CN", timezoneId: "Asia/Shanghai" });
    await context.addInitScript((theme) => localStorage.setItem("vim4-manager-theme", theme), theme);
    await context.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === "POST" && data.pendingWrite) { data.pendingRoute = route; return; }
      if (data.errors[path]) return route.fulfill({ status: 503, json: { error: data.errors[path] } });
      if (path === "/__vim4/api/auth/login") return route.fulfill({ status: 401, json: { error: "用户名或密码错误" } });
      const responses = {
        "/__vim4/api/auth/state": data.auth, "/api/status": data.status, "/api/edid": data.edid, "/api/media": data.media,
        "/api/disks": data.disks, "/api/disks/files": data.files, "/api/storage": data.storage, "/api/nasdisk": data.nasdisk,
        "/api/storage/dirs": { entries: [{ name: "工具" }, { name: "录像" }], truncated: false },
        "/api/wifi": data.wifi, "/api/wifi/networks": { networks: data.networks }, "/api/tailscale": data.tailscale,
        "/api/passthrough": data.passthrough, "/api/kernel": data.kernel, "/api/updates": data.updates, "/api/account/sessions": data.account,
      };
      return route.fulfill({ status: path in responses ? 200 : 404, json: responses[path] ?? { error: "Unexpected test API" } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(scenario.page === "login" ? `${base}/__vim4/login` : `${base}/#/${scenario.page}`);
      await page.getByText(scenario.ready, { exact: false }).first().waitFor();
      for (const action of scenario.actions ?? []) await action(page, data);
      if (scenario.name === "storage-folder") await page.getByRole("button", { name: "工具", exact: true }).waitFor();
      if (scenario.name === "login-error") await page.getByText("用户名或密码错误", { exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      assert.deepEqual(errors, [], scenario.name);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${scenario.name}: horizontal overflow at ${width}px`);
      await page.mouse.move(0, 0);
      await page.evaluate(() => window.scrollTo(0, 0));
      const path = `${out}/${scenario.name}-${theme}-${width}.png`;
      await page.screenshot({ path, fullPage: true, animations: "disabled" });
      captures.push(path.split("/").at(-1));
      console.log(captures.at(-1));
      if (after && width === 1280 && scenario.name === "disks-files") {
        await page.evaluate(() => window.scrollTo(0, 600));
        await page.waitForFunction(() => scrollY > 300);
        const sidebar = await page.locator('[data-slot="sidebar-container"]').boundingBox();
        assert(await page.evaluate(() => scrollY) > 300, "sidebar evidence uses a genuinely scrolled viewport");
        assert(Math.abs(sidebar.y) < 1 && sidebar.height === 900, "sidebar fills the scrolled viewport");
        assert(await page.getByRole("radiogroup", { name: "外观" }).isVisible());
        const scrolled = `sidebar-scrolled-${theme}-${width}.png`;
        await page.screenshot({ path: `${out}/${scrolled}`, fullPage: false, animations: "disabled" });
        captures.push(scrolled);
      }
    } finally { if (data.pendingRoute) await data.pendingRoute.abort().catch(() => {}); await context.close(); }
  }
  await writeFile(`${out}/manifest.json`, JSON.stringify({ base, baseline: "origin/main@fa088412c73c767a919441d96d4f9f6f9a31b12d", candidate: after ? "ui/shadcn-refactor" : "origin/main", themes: ["light", "dark"], widths: [1280, 390], captures }, null, 2) + "\n");
  console.log(`PASS: ${captures.length} offline screenshots in ${out}`);
} finally { await browser.close(); }
