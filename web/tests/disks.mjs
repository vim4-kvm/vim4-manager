import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const status = { active: "nanokvm", apps: [{ id: "nanokvm", name: "NanoKVM", port: 8080, description: "",
    unit: { name: "nanokvm.service", loaded: true, active: "active", enabled: "enabled", sub: "running" } }], platform: [],
    media: { known: true, inserted: false, token: "", name: "", cdrom: false, readOnly: false, connected: false, pikvm: false },
    hardware: { hostname: "vim4", kernel: "5.15", uptimeSeconds: 60, load1: 0, cpus: 8,
      memTotalKiB: 1024, memAvailableKiB: 512, tempC: 50, fanAuto: true, fanPercent: 30,
      zones: [], usb: "configured", hdmi: { signal: true, height: 1080, audio: true }, hdrCurve: { white: 203, peak: 1000 } },
    system: { links: [], disk: { totalBytes: 1024, freeBytes: 512 }, packages: [] }, history: [], events: [] };
  const disks = [
    { name: "disk.img", size: 512 * 2 ** 20, mtime: 1760000000, label: "VIM4KVM", freeBytes: 400 * 2 ** 20,
      attached: false, readOnly: false, editing: false, snapshots: [{ id: "20261016T010000Z", time: 1760576400, size: 512 * 2 ** 20 }] },
    { name: "tools.img", size: 2 ** 30, mtime: 1760000000, label: "TOOLS", freeBytes: 2 ** 29,
      attached: true, readOnly: false, editing: false, snapshots: [] },
  ];
  const files = {
    "/": [{ name: "drivers", dir: true, size: 0, mtime: 1760000000 }, { name: "readme.txt", dir: false, size: 12, mtime: 1760000000 }],
    "/drivers": [],
  };
  const requests = [];
  let failDisks = false;
  await page.route("**/api/status", (route) => route.fulfill({ json: status }));
  await page.route("**/api/disks", (route) => {
    if (route.request().method() === "POST") {
      requests.push({ path: "/api/disks", body: route.request().postDataJSON() });
      return route.fulfill({ status: 400, json: { error: "空间不足" } });
    }
    return failDisks ? route.fulfill({ status: 400, json: { error: "无法读取挂载状态" } }) : route.fulfill({ json: disks });
  });
  await page.route("**/api/disks/files?*", (route) => {
    const url = new URL(route.request().url());
    const entries = files[url.searchParams.get("path")];
    if (!entries) return route.fulfill({ status: 400, json: { error: "路径不存在" } });
    return route.fulfill({ json: { path: url.searchParams.get("path"), stale: url.searchParams.get("disk") === "tools.img", entries } });
  });
  await page.route("**/api/disks/file?*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ path: "PUT", disk: url.searchParams.get("disk"), file: url.searchParams.get("path"),
      overwrite: url.searchParams.get("overwrite"), header: request.headers()["x-vim4-upload"], body: request.postData() });
    return route.fulfill({ json: { ok: true } });
  });
  await page.route(/\/api\/disks\/(mkdir|rm|mv|label|format|delete|check|snapshot|resize)/, (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push({ path, body: route.request().postDataJSON() });
    if (path === "/api/disks/check") return route.fulfill({ json: { ok: true, output: "0 errors" } });
    return route.fulfill({ json: { ok: true } });
  });

  await page.goto(`${process.env.TEST_URL || "http://127.0.0.1:5188"}/#/disks`);
  await page.getByRole("heading", { name: "数据盘", level: 2 }).waitFor();
  await page.getByRole("button", { name: /^readme\.txt/ }).waitFor();
  assert.equal(await page.getByRole("link", { name: "下载 readme.txt" }).getAttribute("href"), "/api/disks/file?disk=disk.img&path=%2Freadme.txt");

  await page.getByRole("button", { name: "新建数据盘" }).click();
  await page.getByPlaceholder("tools").fill("disk");
  await page.getByText("已有同名数据盘。").waitFor();
  assert.equal(await page.getByRole("button", { name: "创建", exact: true }).isDisabled(), true);
  await page.getByPlaceholder("tools").fill("logs");
  await page.getByLabel("卷标").first().fill("my logs!");
  assert.equal(await page.getByLabel("卷标").first().inputValue(), "MY LOGS");
  await page.getByText("4.0 GiB", { exact: true }).click();
  assert.equal(await page.getByRole("radio", { name: "4.0 GiB" }).isChecked(), true);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByText("空间不足", { exact: true }).waitFor();
  assert.deepEqual(requests.at(-1), { path: "/api/disks", body: { name: "logs.img", sizeMiB: 4096, label: "MY LOGS" } });
  await page.getByRole("button", { name: "取消", exact: true }).click();

  await page.locator("input[type=file]").setInputFiles({ name: "readme.txt", mimeType: "text/plain", buffer: Buffer.from("new") });
  await page.getByText(/当前文件夹已有.*是否覆盖/).waitFor();
  await page.getByRole("button", { name: "覆盖", exact: true }).click();
  await page.getByText("已上传 1 个文件到 disk.img").waitFor();
  assert.deepEqual(requests.at(-1), { path: "PUT", disk: "disk.img", file: "/readme.txt", overwrite: "1", header: "1", body: "new" });

  await page.getByRole("button", { name: /^drivers/ }).click();
  await page.getByText("文件夹为空。把文件拖到这里，或点「上传文件」。").waitFor();
  await page.getByRole("button", { name: "新建文件夹" }).click();
  await page.getByLabel("文件夹名称").fill("a/b");
  assert.equal(await page.getByRole("button", { name: "新建", exact: true }).isDisabled(), true);
  await page.getByLabel("文件夹名称").fill("net");
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByText("已新建文件夹 net").waitFor();
  assert.deepEqual(requests.at(-1), { path: "/api/disks/mkdir", body: { disk: "disk.img", path: "/drivers/net" } });
  await page.getByRole("button", { name: "VIM4KVM", exact: true }).click();

  await page.getByRole("button", { name: /^readme\.txt/ }).click();
  await page.getByRole("button", { name: "删除 readme.txt" }).click();
  await page.getByRole("button", { name: "确认删除" }).click();
  await page.getByText("已删除 readme.txt").waitFor();
  assert.deepEqual(requests.at(-1), { path: "/api/disks/rm", body: { disk: "disk.img", path: "/readme.txt" } });

  await page.getByRole("button", { name: "扩容…" }).click();
  await page.getByLabel("新容量（MiB）").fill("256");
  await page.getByLabel(/输入 disk.img 确认/).fill("disk.img");
  assert.equal(await page.getByRole("button", { name: "扩容数据盘", exact: true }).isDisabled(), true);
  await page.getByLabel("新容量（MiB）").fill("1024");
  await page.getByRole("button", { name: "扩容数据盘", exact: true }).click();
  await page.getByText("disk.img 已扩容").waitFor();
  assert.deepEqual(requests.at(-1), { path: "/api/disks/resize", body: { name: "disk.img", sizeMiB: 1024, confirm: "disk.img" } });

  await page.getByRole("button", { name: "格式化…" }).click();
  const format = page.getByRole("button", { name: "格式化", exact: true });
  assert.equal(await format.isDisabled(), true);
  await page.getByLabel(/输入 disk.img 确认/).fill("disk.img");
  await format.click();
  await page.getByText("disk.img 已格式化").waitFor();
  assert.deepEqual(requests.at(-1), { path: "/api/disks/format", body: { name: "disk.img", label: "VIM4KVM", confirm: "disk.img", snapshot: true } });
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/disks-desktop.png`, fullPage: true });

  await page.getByRole("radio", { name: /tools\.img/ }).check({ force: true });
  await page.getByText(/数据盘正挂载在被控电脑上/).waitFor();
  assert.equal(await page.getByRole("button", { name: "上传文件" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "格式化…" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "删除数据盘…" }).isDisabled(), true);
  await page.getByRole("link", { name: "下载 readme.txt" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "删除 readme.txt" }).count(), 0, "attached disks hide file mutations");

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/disks-mobile.png`, fullPage: true });
  failDisks = true;
  await page.reload();
  await page.getByText("无法读取挂载状态").waitFor();
  assert.equal(await page.getByRole("button", { name: "格式化…" }).count(), 0);
  failDisks = false;
  await page.getByRole("button", { name: "重新读取数据盘" }).click();
  await page.getByRole("button", { name: "格式化…" }).waitFor();
  console.log("PASS: create, upload, folders, delete, resize, format, attached lockout, read failure recovery and mobile layout");
} finally { await browser.close(); }
