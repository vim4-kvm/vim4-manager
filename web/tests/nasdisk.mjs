import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const shot = async (page, name) => process.env.SCREENSHOTS && page.screenshot({ path: `${process.env.SCREENSHOTS}/${name}.png`, fullPage: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const status = { active: "onekvm", apps: [{ id: "onekvm", name: "One-KVM", port: 8080, description: "",
    unit: { name: "one-kvm.service", loaded: true, active: "active", enabled: "enabled", sub: "running" } }], platform: [],
    media: { known: true, inserted: false, token: "", name: "", cdrom: false, readOnly: false, connected: false, pikvm: false },
    hardware: { hostname: "vim4", kernel: "5.15", uptimeSeconds: 60, load1: 0, cpus: 8,
      memTotalKiB: 1024, memAvailableKiB: 512, tempC: 50, fanAuto: true, fanPercent: 30,
      zones: [], usb: "configured", hdmi: { signal: true, height: 1080, audio: true }, hdrCurve: { white: 203, peak: 1000 } },
    system: { links: [], disk: { totalBytes: 1024, freeBytes: 512 }, packages: [] }, history: [], events: [] };
  const base = { domain: "", username: "kvm", version: "auto", autoMount: true, error: "", stale: false, busy: false, insecure: false };
  const storages = { known: true, tools: { smb: true, nfs: true }, storages: [
    { ...base, id: "home", name: "家庭 NAS", type: "smb", server: "192.168.50.2", share: "video", mounted: true, state: "mounted",
      path: "/var/lib/vim4-kvm/nas/home", totalBytes: 4 * 2 ** 40, freeBytes: 2 ** 40, writable: true },
  ] };
  const dirs = { "/": ["工具", "录像", ".vim4-nasdisk"], "/工具": ["驱动 2026"], "/工具/驱动 2026": [] };
  const session = { id: "s1", storage: "home", storageName: "家庭 NAS", path: "/工具", mode: "rw", label: "TOOLS",
    state: "scanning", scanned: 1234, files: 0, dirs: 0, volumeBytes: 0, usedBytes: 0, writtenBytes: 0, skipped: [], skippedCount: 0,
    hostConnected: true, plan: null, progress: null, decision: null, error: "", startedAt: 1760000000 };
  let disk = { known: true, session: null, pending: [], last: { id: "s0", storageName: "家庭 NAS", path: "/录像", mode: "rw", result: "committed",
    summary: { mkdirs: 1, writes: 3, renames: 1, deletes: 2, ignored: 4, conflicts: 1 },
    conflicts: [{ path: "/录像/说明.txt", copy: "/录像/说明 (冲突 20261018-010203).txt" }], error: "", finishedAt: 1760000000,
    trash: { files: 3, bytes: 5 * 2 ** 20 } } };
  const requests = [];
  await page.route("**/api/status", (route) => route.fulfill({ json: status }));
  await page.route("**/api/storage", (route) => route.fulfill({ json: storages }));
  await page.route("**/api/storage/dirs?*", (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    return route.fulfill({ json: { path, entries: dirs[path].map((name) => ({ name })), truncated: false } });
  });
  await page.route("**/api/nasdisk", (route) => route.fulfill({ json: disk }));
  await page.route("**/api/storage/mkdir", (route) => {
    const body = route.request().postDataJSON();
    requests.push({ path: "/api/storage/mkdir", body });
    const path = `${body.path === "/" ? "" : body.path}/${body.name}`;
    dirs[body.path].push(body.name);
    dirs[path] = [];
    return route.fulfill({ json: { path } });
  });
  await page.route(/\/api\/nasdisk\/[\w-]+$/, (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push({ path, body: route.request().postDataJSON() });
    if (path === "/api/nasdisk/start") disk = { ...disk, session: { ...session } };
    if (path === "/api/nasdisk/trash-empty") disk = { ...disk, last: { ...disk.last, trash: { files: 0, bytes: 0 } } };
    return route.fulfill({ json: { ok: true } });
  });

  await page.goto(`${process.env.TEST_URL || "http://127.0.0.1:5188"}/#/storage`);
  await page.getByText("已写回 NAS：写入 3 个文件").waitFor();
  await page.getByText("说明 (冲突 20261018-010203).txt").waitFor();
  await page.getByText("回收目录：3 个文件 · 5.0 MiB", { exact: false }).waitFor();
  await page.getByRole("button", { name: "清空…" }).click();
  await page.getByRole("alertdialog", { name: "清空回收目录" }).getByRole("button", { name: "清空回收目录" }).click();
  await page.waitForTimeout(100);
  assert.deepEqual(requests.at(-1), { path: "/api/nasdisk/trash-empty", body: { id: "s0", confirm: "s0" } });
  await page.getByText("回收目录：", { exact: false }).waitFor({ state: "detached" });

  // Picking from the NAS row: browse, label follows the folder, private directory hidden.
  await page.getByRole("button", { name: "作为 U 盘…" }).click();
  await page.getByRole("button", { name: "工具" }).waitFor();
  assert.equal(await page.getByRole("button", { name: ".vim4-nasdisk" }).count(), 0);
  await page.getByRole("button", { name: "工具" }).click();
  await page.getByRole("button", { name: "驱动 2026" }).waitFor();
  await page.getByRole("button", { name: "新建文件夹" }).click();
  const newName = page.getByLabel("新文件夹名称");
  await newName.fill("a:b");
  await page.getByText("名称不能包含", { exact: false }).waitFor();
  await newName.fill("驱动 2026");
  await page.getByText("已有同名文件夹").waitFor();
  assert.equal(await page.getByRole("button", { name: "创建" }).isDisabled(), true);
  await newName.fill("安装包");
  await shot(page, "nasdisk-mkdir");
  await newName.press("Enter");
  await page.getByText("没有子文件夹。").waitFor();
  assert.deepEqual(requests.at(-1), { path: "/api/storage/mkdir", body: { id: "home", path: "/工具", name: "安装包" } });
  assert.equal(await page.locator(".nasdisk-crumbs [aria-current=location]").innerText(), "安装包");
  await page.getByRole("button", { name: "工具" }).click();
  await page.getByRole("button", { name: "驱动 2026" }).waitFor();
  assert.equal(await page.getByLabel("卷标").inputValue(), "NAS", "Chinese folder names fall back to NAS");
  await page.getByLabel("卷标").fill("tools");
  assert.equal(await page.getByLabel("卷标").inputValue(), "TOOLS");
  await page.getByText("将作为 U 盘：").waitFor();
  await shot(page, "nasdisk-setup");
  await page.getByRole("button", { name: "挂载到被控电脑" }).click();
  await page.getByText("正在扫描文件夹… 已扫描 1,234 项").waitFor();
  assert.deepEqual(requests.find((r) => r.path === "/api/nasdisk/start"), { path: "/api/nasdisk/start", body: { storage: "home", path: "/工具", mode: "rw", label: "TOOLS" } });

  disk = { ...disk, session: { ...session, state: "attached", files: 812, dirs: 40, volumeBytes: 70 * 2 ** 30, usedBytes: 6 * 2 ** 30,
    writtenBytes: 12 * 2 ** 20, skippedCount: 2, skipped: [{ path: "/工具/win.iso", reason: "file size outside FAT32 range" },
      { path: "/工具/a:b.txt", reason: "invalid FAT name or more than 255 UTF-16 units" }] } };
  await page.getByText("已挂载到被控电脑").waitFor();
  await page.getByRole("button", { name: "2 项未放入 U 盘" }).click();
  await page.getByText("不小于 4 GiB").waitFor();
  await shot(page, "nasdisk-attached");

  disk = { ...disk, session: { ...disk.session, state: "committing", plan: { mkdirs: 1, writes: 5, renames: 0, deletes: 1, ignored: 3, conflicts: 0 },
    progress: { done: 3, total: 7, bytesDone: 300 * 2 ** 20, bytesTotal: 2 ** 30, current: "/工具/驱动 2026/setup.exe" } } };
  await page.getByText("正在把修改写回 NAS…").waitFor();
  await page.getByText("3 / 7 步", { exact: false }).waitFor();
  await shot(page, "nasdisk-committing");

  disk = { ...disk, session: { ...disk.session, state: "needs-decision", progress: null, decision: { reason: "", canForce: true } } };
  await page.getByText("U 盘没有被安全弹出").waitFor();
  await shot(page, "nasdisk-decision");
  await page.getByRole("button", { name: "放弃修改…" }).click();
  await page.getByRole("alertdialog", { name: "放弃修改" }).getByRole("button", { name: "放弃修改" }).click();
  await page.waitForTimeout(100);
  assert.deepEqual(requests.at(-1), { path: "/api/nasdisk/discard", body: { id: "s1", confirm: "s1" } });
  await page.getByRole("button", { name: "重新挂载" }).click();
  await page.waitForTimeout(100);
  assert.deepEqual(requests.at(-1), { path: "/api/nasdisk/reattach", body: { id: "s1" } });

  disk = { ...disk, session: null, pending: [{ id: "p1", storage: "home", storageName: "家庭 NAS", path: "/", writtenBytes: 2 ** 30, startedAt: 1760000000, journal: true }] };
  await page.getByText("未写回的修改").waitFor();
  await page.getByRole("button", { name: "写回 NAS" }).click();
  await page.waitForTimeout(100);
  assert.deepEqual(requests.at(-1), { path: "/api/nasdisk/commit", body: { id: "p1" } });
  await shot(page, "nasdisk-pending");

  await page.setViewportSize({ width: 390, height: 844 });
  disk = { ...disk, session: { ...session, state: "needs-decision", decision: { reason: "", canForce: true }, skippedCount: 0 } };
  await page.getByText("U 盘没有被安全弹出").waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await shot(page, "nasdisk-mobile");
  console.log("PASS: trash summary and empty, folder picker, new folder, label, start, scanning, attached with skipped list, write-back progress, decision actions, pending commit, last result, mobile layout");
} finally { await browser.close(); }
