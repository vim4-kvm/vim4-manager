import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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
    if (path === "/api/storage/unmount") return route.fulfill({ status: 409, json: { error: "正在被录制使用，请先停止录制" } });
    return route.fulfill({ json: { ok: true } });
  });

  await page.goto(`${process.env.TEST_URL || "http://127.0.0.1:5188"}/#/storage`);
  await page.getByRole("heading", { name: "网络存储", level: 2 }).waitFor();
  await page.getByText("//192.168.50.2/video/kvm").waitFor();
  await page.getByText("[fd00::5]:/export/lab").waitFor();
  await page.getByText("主机不可达").waitFor();
  await page.getByText("板子没有写入权限", { exact: false }).waitFor();
  await page.getByText("剩余 1.2 TiB / 4.0 TiB").waitFor();
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
  await page.getByRole("button", { name: "编辑" }).first().click();
  await page.getByText("/var/lib/vim4-kvm/nas/home").waitFor();
  assert.equal(await page.getByRole("group", { name: "协议" }).count(), 0, "type is fixed after creation");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const edited = requests.filter((r) => r.path === "/api/storage").at(-1).body;
  assert.equal(edited.id, "home");
  assert.equal("password" in edited, false);

  // Unmount failure is shown, delete sends the name as confirmation.
  await page.getByRole("button", { name: "断开" }).first().click();
  await page.getByRole("alertdialog", { name: "断开" }).getByRole("button", { name: "断开" }).click();
  await page.getByText("正在被录制使用，请先停止录制").waitFor();
  await page.getByRole("button", { name: "编辑" }).nth(1).click();
  await page.getByRole("button", { name: "删除连接…" }).click();
  await page.getByRole("alertdialog", { name: "删除连接" }).getByRole("button", { name: "删除连接" }).click();
  await page.waitForTimeout(100);
  assert.deepEqual(requests.find((r) => r.path === "/api/storage/delete").body, { id: "lab", confirm: "lab" });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "添加 NAS" }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/storage-mobile.png`, fullPage: true });

  state = { known: true, tools: { smb: false, nfs: true }, storages: [] };
  await page.reload();
  await page.getByText("还没有连接 NAS").waitFor();
  await page.getByText("SMB（cifs-utils）", { exact: false }).waitFor();
  console.log("PASS: list states, add with test, NFS validation, edit keeps password, unmount error, delete confirm, missing tools, mobile layout");
} finally { await browser.close(); }
