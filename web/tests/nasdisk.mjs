import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
async function shot(page, name) {
  if (!process.env.SCREENSHOTS) return;
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${process.env.SCREENSHOTS}/${name}.png`, fullPage: true, animations: "disabled" });
}
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Shanghai" });
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
  let dirFailure = false;
  await page.route("**/api/**", (route) => route.fulfill({ status: 404, json: { error: "Unexpected test API" } }));
  await page.route("**/api/status", (route) => route.fulfill({ json: status }));
  await page.route("**/api/storage", (route) => route.fulfill({ json: storages }));
  await page.route("**/api/storage/dirs?*", (route) => {
    if (dirFailure) return route.fulfill({ status: 503, json: { error: "文件夹读取失败" } });
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

  await (await import("./auth-fixture.mjs")).authenticated(page);
  await page.goto(`${process.env.TEST_URL || "http://127.0.0.1:5188"}/#/storage`);
  await page.locator(".nasdisk-last-summary").filter({ hasText: "已写回 NAS：写入 3 个文件" }).waitFor();
  await page.getByText("说明 (冲突 20261018-010203).txt").waitFor();
  await page.getByText("回收目录 5.0 MiB", { exact: true }).waitFor();
  await shot(page, "nasdisk-last-conflicts");
  await page.getByRole("button", { name: "清空…" }).click();
  await page.getByRole("alertdialog", { name: "清空回收目录" }).getByRole("button", { name: "清空回收目录" }).click();
  await page.waitForTimeout(100);
  assert.deepEqual(requests.at(-1), { path: "/api/nasdisk/trash-empty", body: { id: "s0", confirm: "s0" } });
  await page.locator(".nasdisk-trash").waitFor({ state: "detached" });

  // Hiding persists across polling and reloads, but is scoped to the result ID.
  await page.getByRole("button", { name: "隐藏上次结果" }).click();
  assert.equal(await page.getByRole("region", { name: "U 盘活动" }).count(), 0);
  await page.reload();
  await page.getByText("//192.168.50.2/video").waitFor();
  await page.waitForResponse((r) => new URL(r.url()).pathname === "/api/nasdisk");
  assert.equal(await page.locator(".nasdisk-last").count(), 0);
  disk = { ...disk, last: { ...disk.last, id: "s2", summary: { mkdirs: 0, writes: 1, renames: 0, deletes: 0, ignored: 0, conflicts: 0 }, conflicts: [], trash: { files: 1, bytes: 190 * 2 ** 20 } } };
  await page.locator(".nasdisk-last-summary").filter({ hasText: "已写回 NAS：写入 1 个文件。" }).waitFor();
  const lastLine = await page.locator(".nasdisk-last-line").boundingBox();
  assert.ok(lastLine.height < 45, "a simple last result occupies one desktop line");
  await shot(page, "nasdisk-last");

  // Picking from the NAS row: browse, label follows the folder, private directory hidden.
  await page.getByRole("button", { name: "作为 U 盘…" }).click();
  assert.equal(await page.locator(".storage-list > li .nasdisk-setup").count(), 1);
  await page.locator(".nasdisk-chosen").filter({ hasText: "已选择 家庭 NAS › 根目录" }).waitFor();
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
  assert.equal(await page.getByLabel("卷标").count(), 0);
  await page.getByRole("button", { name: "修改", exact: true }).click();
  assert.equal(await page.getByLabel("卷标").inputValue(), "NAS", "Chinese folder names fall back to NAS");
  await page.getByLabel("卷标").fill("bad!");
  assert.equal(await page.getByRole("button", { name: "挂载到被控电脑" }).isDisabled(), true);
  await page.getByLabel("卷标").fill("tools");
  assert.equal(await page.getByLabel("卷标").inputValue(), "TOOLS");
  await page.locator(".nasdisk-chosen").filter({ hasText: "已选择 家庭 NAS › 工具" }).waitFor();
  await page.getByRole("button", { name: "驱动 2026" }).click();
  await page.getByText("没有子文件夹。").waitFor();
  assert.equal(await page.getByLabel("卷标").inputValue(), "TOOLS", "manual label survives navigation");
  await page.getByRole("button", { name: "工具", exact: true }).click();
  await page.getByRole("button", { name: "驱动 2026" }).waitFor();
  await shot(page, "nasdisk-setup");
  await page.getByRole("button", { name: "挂载到被控电脑" }).click();
  await page.getByText("正在扫描文件夹… 已扫描 1,234 项").waitFor();
  await page.getByText("U 盘使用中", { exact: true }).waitFor();
  assert.equal(await page.locator(".nasdisk-setup").count(), 0);
  const mountButton = page.getByRole("button", { name: "作为 U 盘…" });
  assert.equal(await mountButton.isDisabled(), true);
  assert.equal(await mountButton.getAttribute("title"), "同一时间只能有一个 U 盘");
  await page.getByRole("button", { name: "家庭 NAS 的更多操作" }).click();
  for (const name of ["断开", "删除"]) {
    assert.equal(await page.getByRole("menuitem", { name }).isDisabled(), true);
    assert.equal(await page.getByRole("menuitem", { name }).getAttribute("title"), "U 盘正在使用此 NAS");
  }
  await shot(page, "nasdisk-scanning");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("alertdialog", { name: "取消挂载" }).getByRole("button", { name: "返回" }).click();
  assert.deepEqual(requests.find((r) => r.path === "/api/nasdisk/start"), { path: "/api/nasdisk/start", body: { storage: "home", path: "/工具", mode: "rw", label: "TOOLS", utcOffsetMinutes: 480 } });

  disk = { ...disk, session: { ...session, state: "attaching" } };
  await page.getByText("正在连接被控电脑…").waitFor();
  await shot(page, "nasdisk-attaching");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("alertdialog", { name: "取消挂载" }).getByRole("button", { name: "取消挂载" }).click();
  await page.waitForResponse((r) => new URL(r.url()).pathname === "/api/nasdisk");
  assert.equal(requests.at(-1).path, "/api/nasdisk/cancel");

  disk = { ...disk, session: { ...session, state: "attached", files: 812, dirs: 40, volumeBytes: 70 * 2 ** 30, usedBytes: 6 * 2 ** 30,
    writtenBytes: 12 * 2 ** 20, skippedCount: 2, skipped: [{ path: "/工具/win.iso", reason: "file size outside FAT32 range" },
      { path: "/工具/a:b.txt", reason: "invalid FAT name or more than 255 UTF-16 units" }] } };
  await page.getByText("已挂载到被控电脑").waitFor();
  assert.equal(await page.locator(".nasdisk-session .storage-actions").getByRole("button").count(), 0);
  await page.getByText("在电脑上安全弹出后，修改会写回 NAS。", { exact: true }).waitFor();
  await page.getByText("如何安全弹出", { exact: true }).click();
  await page.getByText("Mac：访达侧栏", { exact: false }).waitFor();
  assert.equal(await page.getByText("NAS 暂时无响应", { exact: false }).count(), 0);
  disk = { ...disk, session: { ...disk.session, nasStalled: true } };
  await page.getByText("NAS 暂时无响应，电脑上读写这个 U 盘会出错", { exact: false }).waitFor();
  disk = { ...disk, session: { ...disk.session, nasStalled: false } };
  await page.getByText("NAS 暂时无响应", { exact: false }).waitFor({ state: "detached" });
  await page.getByRole("button", { name: "2 项未放入 U 盘" }).click();
  await page.getByText("不小于 4 GiB").waitFor();
  await shot(page, "nasdisk-attached");

  disk = { ...disk, session: { ...disk.session, state: "parsing" } };
  await page.getByText("已弹出，正在检查修改…").waitFor();
  await shot(page, "nasdisk-parsing");

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

  disk = { ...disk, session: { ...disk.session, state: "failed", decision: null, error: "读取 NAS 上的文件失败", detail: "read /工具/a.bin: input/output error" } };
  await page.getByText("未写回的修改仍保存在 NAS 的暂存区").waitFor();
  await page.getByText("技术细节").click();
  await page.getByText("read /工具/a.bin: input/output error").waitFor();
  await page.getByRole("button", { name: "重试写回" }).click();
  await page.waitForTimeout(100);
  assert.deepEqual(requests.at(-1), { path: "/api/nasdisk/commit", body: { id: "s1" } });
  await page.getByRole("button", { name: "放弃修改…" }).waitFor();
  await shot(page, "nasdisk-failed");

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

  // Inline setup, preflight and responsive actions use the current status poll.
  disk = { known: true, session: null, last: null, pending: [] };
  await page.getByRole("region", { name: "U 盘活动" }).waitFor({ state: "detached" });
  dirFailure = true;
  await mountButton.click();
  await page.getByText("文件夹读取失败", { exact: false }).waitFor();
  assert.equal(await page.getByRole("button", { name: "挂载到被控电脑" }).isDisabled(), true);
  dirFailure = false;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.getByRole("button", { name: "工具", exact: true }).waitFor();
  status.media = { ...status.media, inserted: true, name: "ubuntu.iso" };
  status.hardware.usb = "not attached";
  await page.getByText("虚拟介质已挂载「ubuntu.iso」", { exact: false }).waitFor();
  assert.equal(await page.locator(".nasdisk-setup").getByRole("link", { name: "虚拟介质页" }).getAttribute("href"), "#/media");
  assert.equal(await page.getByRole("button", { name: "挂载到被控电脑" }).isDisabled(), true);
  await page.getByText("被控电脑尚未通过 USB 连接，连接后即可看到 U 盘。", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const primary = await page.getByRole("button", { name: "挂载到被控电脑" }).boundingBox();
  const cancel = await page.locator(".nasdisk-setup").getByRole("button", { name: "取消", exact: true }).boundingBox();
  assert.ok(primary.y < cancel.y && Math.abs(primary.width - cancel.width) < 1);
  const modes = page.getByRole("group", { name: "模式" }).getByRole("button");
  assert.ok((await modes.nth(0).boundingBox()).y < (await modes.nth(1).boundingBox()).y);
  await shot(page, "nasdisk-preflight-mobile");
  await page.setViewportSize({ width: 1280, height: 900 });
  await shot(page, "nasdisk-preflight");
  status.media.inserted = false;
  await page.getByText("虚拟介质已挂载「ubuntu.iso」", { exact: false }).waitFor({ state: "detached" });
  assert.equal(await page.getByRole("button", { name: "挂载到被控电脑" }).isDisabled(), false, "USB warning does not prevent mounting");

  // A second NAS replaces the open picker, and editing/adding closes it.
  storages.storages.push({ ...storages.storages[0], id: "archive", name: "归档 NAS", writable: false });
  const archive = page.locator(".storage-list > li").filter({ hasText: "归档 NAS" });
  await archive.getByRole("button", { name: "作为 U 盘…" }).click();
  assert.equal(await page.locator(".nasdisk-setup").count(), 1);
  await archive.locator(".nasdisk-chosen").filter({ hasText: "归档 NAS › 根目录" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "可写 NAS 不允许写入" }).isDisabled(), true);
  await page.getByRole("button", { name: "添加 NAS" }).click();
  assert.equal(await page.locator(".nasdisk-setup").count(), 0);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await archive.getByRole("button", { name: "作为 U 盘…" }).click();
  await page.getByRole("button", { name: "归档 NAS 的更多操作" }).click();
  await page.getByRole("menuitem", { name: "编辑" }).click();
  assert.equal(await page.locator(".nasdisk-setup").count(), 0);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await archive.getByRole("button", { name: "作为 U 盘…" }).click();
  await page.getByRole("button", { name: "工具", exact: true }).waitFor();
  await page.getByRole("button", { name: "挂载到被控电脑" }).click();
  await page.getByText("正在扫描文件夹… 已扫描 1,234 项").waitFor();
  assert.equal(requests.filter((r) => r.path === "/api/nasdisk/start").at(-1).body.mode, "ro");
  for (const button of await page.getByRole("button", { name: "作为 U 盘…" }).all()) assert.equal(await button.isDisabled(), true);
  console.log("PASS: inline folder selection/retry/mkdir, label editing, LUN and USB preflight, read-only NAS, all activity states and actions, session locks, pending, persistent last-result dismissal, compact result, desktop/mobile layout");
} finally { await browser.close(); }
