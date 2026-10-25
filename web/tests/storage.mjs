import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const status = { active: "onekvm", apps: [{ id: "onekvm", name: "One-KVM", port: 8080, description: "",
    unit: { name: "one-kvm.service", loaded: true, active: "active", enabled: "enabled", sub: "running" } }], platform: [],
    media: { known: true, inserted: false, token: "", name: "", cdrom: false, readOnly: false, connected: false, pikvm: false },
    hardware: { hostname: "vim4", kernel: "5.15", uptimeSeconds: 60, load1: 0, cpus: 8,
      memTotalKiB: 1024, memAvailableKiB: 512, tempC: 50, fanAuto: true, fanPercent: 30,
      zones: [], usb: "configured", hdmi: { signal: true, height: 1080, audio: true }, hdrCurve: { white: 203, peak: 1000 } },
    system: { links: [], disk: { totalBytes: 1024, freeBytes: 512 }, packages: [] }, history: [], events: [] };
  const base = { domain: "", username: "", version: "auto", autoMount: true, error: "", stale: false, busy: false, insecure: false };
  const storages = [
    { ...base, id: "home", name: "家庭 NAS", type: "smb", server: "192.168.50.2", share: "video/kvm", username: "kvm",
      mounted: true, state: "mounted", path: "/var/lib/vim4-kvm/nas/home", totalBytes: 4 * 2 ** 40, freeBytes: 1.2 * 2 ** 40, writable: true },
    { ...base, id: "lab", name: "lab", type: "nfs", server: "fd00::5", share: "/export/lab", autoMount: false,
      mounted: false, state: "error", error: "主机不可达", path: "/var/lib/vim4-kvm/nas/lab", totalBytes: null, freeBytes: null, writable: null },
    { ...base, id: "old", name: "旧 NAS", type: "smb", server: "old.local", share: "public", version: "1.0", insecure: true,
      mounted: true, state: "mounted", path: "/var/lib/vim4-kvm/nas/old", totalBytes: 2 ** 40, freeBytes: 2 ** 34, writable: false },
  ];
  let state = { known: true, tools: { smb: true, nfs: true }, storages };
  const requests = [];
  await page.route("**/api/**", (route) => route.fulfill({ status: 404, json: { error: "Unexpected test API" } }));
  await page.route("**/api/nasdisk", (route) => route.fulfill({ json: { known: true, session: null, last: null, pending: [] } }));
  await page.route("**/api/status", (route) => route.fulfill({ json: status }));
  await page.route("**/api/storage", (route) => {
    if (route.request().method() === "POST") {
      requests.push({ path: "/api/storage", body: route.request().postDataJSON() });
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: state });
  });
  let testReply = { ok: true, totalBytes: 2 ** 40, freeBytes: 2 ** 39, writable: true, elapsedMs: 84 };
  await page.route("**/api/storage/test", (route) => {
    requests.push({ path: "/api/storage/test", body: route.request().postDataJSON() });
    return route.fulfill({ json: testReply });
  });
  await page.route(/\/api\/storage\/(mount|unmount|delete)$/, (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push({ path, body: route.request().postDataJSON() });
    if (path === "/api/storage/mount") Object.assign(storages[1], { mounted: true, state: "mounted", error: "" });
    if (path === "/api/storage/unmount") return route.fulfill({ status: 409, json: { error: "正在被录制使用，请先停止录制" } });
    return route.fulfill({ json: { ok: true } });
  });

  await (await import("./auth-fixture.mjs")).authenticated(page);
  await page.goto(`${process.env.TEST_URL || "http://127.0.0.1:5188"}/#/storage`);
  await page.getByRole("heading", { name: "网络存储", level: 1 }).waitFor();
  await page.getByText("//192.168.50.2/video/kvm").waitFor();
  await page.getByText("[fd00::5]:/export/lab").waitFor();
  await page.getByText("主机不可达").waitFor();
  await page.getByText("板子没有写入权限", { exact: false }).waitFor();
  await page.getByText("剩余 1.2 TiB / 4.0 TiB").waitFor();
  assert.equal(await page.getByRole("region", { name: "U 盘活动" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "选择文件夹…" }).count(), 0);
  const home = page.getByRole("list", { name: "NAS 连接" }).getByRole("listitem").filter({ hasText: "家庭 NAS" });
  const lab = page.getByRole("list", { name: "NAS 连接" }).getByRole("listitem").filter({ hasText: "[fd00::5]" });
  assert.equal(await home.getByRole("button", { name: "作为 U 盘…" }).count(), 1);
  assert.equal(await lab.getByRole("button", { name: "连接", exact: true }).count(), 1);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/storage-list.png`, fullPage: true });

  // Adding: test then save; the password travels only in the request body.
  await page.getByRole("button", { name: "添加 NAS" }).click();
  assert.equal(await page.getByRole("button", { name: "保存并连接" }).isDisabled(), true);
  await page.getByLabel("服务器").fill("192.168.50.9");
  await page.getByLabel("共享名").fill("/media/rec/");
  await page.getByLabel("用户名").fill("kvm");
  await page.getByLabel("密码", { exact: true }).fill("p,ss=word");
  await page.getByText("将连接").waitFor();
  await page.getByRole("button", { name: "测试连接" }).click();
  await page.getByText("连接成功，可以写入").waitFor();
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/storage-add.png`, fullPage: true });
  await page.getByRole("button", { name: "保存并连接" }).click();
  await page.getByRole("button", { name: "添加 NAS" }).waitFor();
  const saved = requests.find((r) => r.path === "/api/storage").body;
  assert.deepEqual(
    { name: saved.name, type: saved.type, server: saved.server, share: saved.share, username: saved.username, password: saved.password, autoMount: saved.autoMount },
    { name: "rec", type: "smb", server: "192.168.50.9", share: "/media/rec/", username: "kvm", password: "p,ss=word", autoMount: true },
  );

  // NFS switch hides credentials and validates the export path.
  await page.getByRole("button", { name: "添加 NAS" }).click();
  await page.getByRole("button", { name: /^NFS/ }).click();
  assert.equal(await page.getByLabel("用户名").count(), 0);
  await page.getByLabel("服务器").fill("nas.local");
  await page.getByLabel("导出路径").fill("volume1");
  assert.equal(await page.getByRole("button", { name: "保存并连接" }).isDisabled(), true);
  await page.getByLabel("导出路径").fill("/volume1/kvm");
  testReply = { ok: true, totalBytes: 2 ** 40, freeBytes: 2 ** 39, writable: false, elapsedMs: 40 };
  await page.getByRole("button", { name: "测试连接" }).click();
  await page.getByText("可以读取，但没有写入权限").waitFor();
  await page.getByRole("button", { name: "取消" }).click();

  // Editing keeps the saved password unless a new one is typed.
  const more = home.getByRole("button", { name: "家庭 NAS 的更多操作" });
  await more.focus();
  await more.press("Enter");
  await page.getByRole("menu").waitFor();
  assert.equal(await page.getByRole("menuitem", { name: "编辑" }).evaluate((el) => el === document.activeElement), true);
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.getByRole("menuitem", { name: "断开" }).evaluate((el) => el === document.activeElement), true);
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "hidden" });
  assert.equal(await more.evaluate((el) => el === document.activeElement), true);
  await more.press("Space");
  await page.getByRole("heading", { name: "网络存储", level: 1 }).click();
  await page.getByRole("menu").waitFor({ state: "hidden" });
  await more.click();
  await page.getByRole("menuitem", { name: "编辑" }).click();
  await page.getByText("/var/lib/vim4-kvm/nas/home").waitFor();
  assert.equal(await page.getByRole("group", { name: "协议" }).count(), 0, "type is fixed after creation");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const edited = requests.filter((r) => r.path === "/api/storage").at(-1).body;
  assert.equal(edited.id, "home");
  assert.equal("password" in edited, false);

  // Unmount failure is shown, delete sends the name as confirmation.
  await more.click();
  await page.getByRole("menuitem", { name: "断开" }).click();
  await page.getByRole("alertdialog", { name: "断开" }).getByRole("button", { name: "断开" }).click();
  await page.getByText("正在被录制使用，请先停止录制").waitFor();
  await lab.getByRole("button", { name: "连接", exact: true }).click();
  await lab.getByRole("button", { name: "作为 U 盘…" }).waitFor();
  assert.equal(await lab.getByRole("button", { name: "连接", exact: true }).count(), 0);
  await lab.getByRole("button", { name: "lab 的更多操作" }).click();
  await page.getByRole("menuitem", { name: "删除" }).click();
  await page.getByRole("alertdialog", { name: "删除连接" }).getByRole("button", { name: "删除连接" }).click();
  await page.waitForTimeout(100);
  assert.deepEqual(requests.find((r) => r.path === "/api/storage/delete").body, { id: "lab", confirm: "lab" });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "添加 NAS" }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/storage-mobile.png`, fullPage: true });

  state = { known: true, tools: { smb: false, nfs: true }, storages: [] };
  await page.reload();
  await page.getByText("还没有 NAS", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "添加 NAS" }).count(), 1);
  assert.equal(await page.getByRole("list", { name: "NAS 连接" }).count(), 0);
  await page.getByText("SMB（cifs-utils）", { exact: false }).waitFor();
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/storage-empty.png`, fullPage: true });
  await page.getByRole("button", { name: "添加 NAS" }).click();
  await page.getByLabel("服务器").waitFor();
  console.log("PASS: empty state, row action transitions, keyboard/outside/Escape menu, add with test, NFS validation, edit keeps password, unmount error, delete confirm, missing tools, mobile layout");
} finally { await browser.close(); }
