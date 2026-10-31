import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
// Destructive text must stay >= 4.5:1 on its own tinted button, at rest and on hover, in both themes.
async function destructiveContrast(page) {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const rgba = (value) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const result = [...context.getImageData(0, 0, 1, 1).data];
      result[3] /= 255;
      return result;
    };
    const blend = (top, bottom) => top.slice(0, 3).map((v, i) => v * (top[3] ?? 1) + bottom[i] * (1 - (top[3] ?? 1)));
    const surface = (el) => el ? blend(rgba(getComputedStyle(el).backgroundColor), surface(el.parentElement)) : [255, 255, 255];
    const lum = (c) => { const l = c.map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return l[0] * .2126 + l[1] * .7152 + l[2] * .0722; };
    return [...document.querySelectorAll("main button[data-variant=destructive]:not(:disabled)")].map((el) => {
      const a = lum(rgba(getComputedStyle(el).color)), b = lum(surface(el));
      return { text: el.textContent, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
    });
  });
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await (await import("./auth-fixture.mjs")).pinLanguage(page);
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
    "/": [{ name: "drivers", dir: true, size: 0, mtime: 1760000000 }, { name: "readme.txt", dir: false, size: 12, mtime: 1760000000 },
      { name: "a-longer-file-name.bin", dir: false, size: 2048, mtime: 1760000600 }],
    "/drivers": [],
  };
  const requests = [];
  let failDisks = false;
  await page.route("**/api/status", (route) => route.fulfill({ json: status }));
  await page.route("**/api/disks", (route) => {
    if (route.request().method() === "POST") {
      requests.push({ path: "/api/disks", body: route.request().postDataJSON() });
      return route.fulfill({ status: 400, json: { error: "Not enough space" } });
    }
    return failDisks ? route.fulfill({ status: 400, json: { error: "Couldn't read the mount status" } }) : route.fulfill({ json: disks });
  });
  await page.route("**/api/disks/files?*", (route) => {
    const url = new URL(route.request().url());
    const entries = files[url.searchParams.get("path")];
    if (!entries) return route.fulfill({ status: 400, json: { error: "Path not found" } });
    return route.fulfill({ json: { path: url.searchParams.get("path"), stale: url.searchParams.get("disk") === "tools.img", entries } });
  });
  await page.route("**/api/disks/file?*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ path: "PUT", disk: url.searchParams.get("disk"), file: url.searchParams.get("path"),
      overwrite: url.searchParams.get("overwrite"), header: request.headers()["x-vim4-upload"], body: request.postData() });
    if (holdUpload) return holdUpload.then(() => route.fulfill({ json: { ok: true } }));
    return route.fulfill({ json: { ok: true } });
  });
  let holdUpload;
  await page.route(/\/api\/disks\/(mkdir|rm|mv|label|format|delete|check|snapshot|resize)/, (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push({ path, body: route.request().postDataJSON() });
    if (path === "/api/disks/check") return route.fulfill({ json: { ok: true, output: "0 errors" } });
    return route.fulfill({ json: { ok: true } });
  });

  await (await import("./auth-fixture.mjs")).authenticated(page);
  await page.goto(`${process.env.TEST_URL || "http://127.0.0.1:5188"}/#/disks`);
  await page.getByRole("heading", { name: "Data disk", level: 1 }).waitFor();
  await page.getByRole("button", { name: /^readme\.txt/ }).waitFor();
  const fileRow = page.getByRole("button", { name: /^readme\.txt/ });
  const otherRow = page.getByRole("button", { name: /^a-longer-file-name/ });
  const right = async (locator) => { const box = await locator.boundingBox(); return box.x + box.width; };
  const sizeEdge = await right(fileRow.getByText("12 B", { exact: true }));
  assert(Math.abs(sizeEdge - await right(otherRow.getByText("2 KiB", { exact: true }))) < 1, "sizes share a fixed right-aligned track");
  const dates = [fileRow, otherRow].map(row => row.getByText(/Oct.*2025/));
  assert(Math.abs(await right(dates[0]) - await right(dates[1])) < 1, "dates share the trailing track");
  const rowEdge = await right(fileRow);
  assert(Math.abs(rowEdge - await right(dates[0])) < 2, "trailing date is flush with the content edge");
  await fileRow.hover();
  assert(Math.abs(sizeEdge - await right(fileRow.getByText("12 B", { exact: true }))) < 1, "hover actions do not move metadata");
  await page.mouse.move(0, 0);
  await page.getByRole("button", { name: "Maintenance", exact: true }).click();
  for (const theme of ["Light", "Dark"]) {
    await page.getByRole("button", { name: "Change appearance" }).click();
    await page.getByRole("menuitemradio", { name: theme, exact: true }).click();
    const rest = await destructiveContrast(page);
    await page.getByRole("button", { name: "Format…" }).hover();
    await page.waitForTimeout(200);
    const hover = await destructiveContrast(page);
    assert(rest.length >= 2, "format and delete buttons are measured");
    for (const value of [...rest, ...hover]) assert(value.ratio >= 4.5, `${theme} destructive contrast ${JSON.stringify(value)}`);
  }
  await page.getByRole("button", { name: "Change appearance" }).click();
  await page.getByRole("menuitemradio", { name: "System", exact: true }).click();
  await page.mouse.move(0, 0);
  assert.equal(await page.getByRole("link", { name: "Download readme.txt" }).count(), 0, "row actions are not clickable while hidden");
  await page.getByRole("button", { name: /^readme\.txt/ }).click();
  assert.equal(await page.getByRole("link", { name: "Download readme.txt" }).getAttribute("href"), "/api/disks/file?disk=disk.img&path=%2Freadme.txt");
  await page.getByText("/readme.txt", { exact: true }).waitFor();
  assert.equal(await page.getByRole("radio", { checked: true }).locator("..").getByText("Available").count(), 1);

  // A stray drop outside the file list must not navigate away.
  const dropOutside = () => page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(["x"], "stray.txt"));
    const event = new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true });
    document.getElementById("page-title").dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(await dropOutside(), true, "window drop guard prevents file navigation");

  await page.getByRole("button", { name: "Create data disk" }).click();
  await page.getByPlaceholder("tools").fill("disk");
  await page.getByText("A data disk with this name already exists").waitFor();
  assert.equal(await page.getByRole("button", { name: "Create", exact: true }).isDisabled(), true);
  await page.getByPlaceholder("tools").fill("logs");
  await page.getByRole("dialog", { name: "Create data disk" }).getByLabel("Volume label").fill("my logs!");
  assert.equal(await page.getByRole("dialog", { name: "Create data disk" }).getByLabel("Volume label").inputValue(), "MY LOGS");
  await page.getByText("4.0 GiB", { exact: true }).click();
  assert.equal(await page.getByRole("radio", { name: "4.0 GiB" }).isChecked(), true);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByText("Not enough space", { exact: true }).waitFor();
  assert.deepEqual(requests.at(-1), { path: "/api/disks", body: { name: "logs.img", sizeMiB: 4096, label: "MY LOGS" } });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.locator("input[type=file]").setInputFiles({ name: "readme.txt", mimeType: "text/plain", buffer: Buffer.from("new") });
  await page.getByText(/This folder already contains.*Replace it/).waitFor();
  let release;
  holdUpload = new Promise((resolve) => { release = resolve; });
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  await page.getByText(/(Uploading|Writing) readme\.txt/).waitFor();
  let dialog;
  page.once("dialog", (d) => { dialog = d.message(); void d.dismiss(); });
  await page.getByRole("link", { name: /Virtual media/ }).click();
  assert.match(dialog ?? "", /Leaving will interrupt/);
  assert.match(page.url(), /#\/disks$/, "dismissing the prompt keeps the upload page");
  release();
  holdUpload = undefined;
  await page.getByText("Files uploaded: 1", { exact: true }).waitFor();
  await page.getByText("Files uploaded to disk.img: 1").waitFor();
  await page.getByText("Files uploaded: 1", { exact: true }).waitFor({ state: "detached" });
  assert.deepEqual(requests.at(-1), { path: "PUT", disk: "disk.img", file: "/readme.txt", overwrite: "1", header: "1", body: "new" });

  await page.getByRole("button", { name: /^drivers/ }).click();
  await page.getByText("This folder is empty. Drop files here or choose Upload files.").waitFor();
  await page.getByRole("button", { name: "Create folder" }).click();
  await page.getByLabel("Folder name").fill("a/b");
  assert.equal(await page.getByRole("button", { name: "Create", exact: true }).isDisabled(), true);
  await page.getByLabel("Folder name").fill("net");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByText("Folder net created").waitFor();
  assert.deepEqual(requests.at(-1), { path: "/api/disks/mkdir", body: { disk: "disk.img", path: "/drivers/net" } });
  await page.getByRole("button", { name: "VIM4KVM", exact: true }).click();

  await page.getByRole("button", { name: /^readme\.txt/ }).click();
  await page.getByRole("button", { name: "Delete readme.txt" }).click();
  await page.getByRole("button", { name: "Confirm deletion" }).waitFor();
  await page.waitForTimeout(4200);
  assert(await page.getByRole("alertdialog", { name: "Delete readme.txt" }).isVisible(), "the delete confirmation stays open until the user acts");
  assert.notEqual(requests.at(-1).path, "/api/disks/rm", "waiting never deletes");
  await page.keyboard.press("Escape");
  await page.getByRole("alertdialog").waitFor({ state: "detached" });
  assert.notEqual(requests.at(-1).path, "/api/disks/rm", "Escape cancels the delete");
  await page.getByRole("button", { name: "Delete readme.txt" }).click();
  await page.getByRole("button", { name: "Confirm deletion" }).click();
  await page.getByText("readme.txt deleted").waitFor();
  assert.deepEqual(requests.at(-1), { path: "/api/disks/rm", body: { disk: "disk.img", path: "/readme.txt" } });

  const snapshotsBefore = requests.length;
  await page.getByRole("button", { name: /Delete snapshot of .*/ }).click();
  assert.equal(requests.length, snapshotsBefore, "deleting a snapshot needs a second click");
  await page.getByRole("button", { name: "Delete snapshot?" }).click();
  await page.getByText("Snapshot deleted").waitFor();
  assert.equal(requests.at(-1).path, "/api/disks/snapshot/delete");

  await page.getByRole("button", { name: "Expand…" }).click();
  assert.equal(await page.getByRole("button", { name: "Expand…" }).getAttribute("aria-expanded"), "true");
  assert.equal(await page.getByRole("radio", { name: "512.0 MiB", exact: true }).count(), 0, "only larger sizes are offered");
  assert.equal(await page.getByRole("radio", { name: "1.0 GiB", exact: true }).isChecked(), true);
  await page.getByText("4.0 GiB", { exact: true }).last().click();
  await page.getByRole("button", { name: "Expand to 4.0 GiB" }).click();
  await page.getByText("disk.img expanded").waitFor();
  assert.deepEqual(requests.at(-1), { path: "/api/disks/resize", body: { name: "disk.img", sizeMiB: 4096, confirm: "disk.img" } });

  await page.getByRole("button", { name: "Format…" }).click();
  const format = page.getByRole("button", { name: "Format", exact: true });
  assert.equal(await format.isDisabled(), true);
  await page.getByLabel(/Enter disk.img to confirm/).fill("disk.img");
  await format.click();
  await page.getByText("disk.img formatted").waitFor();
  assert.deepEqual(requests.at(-1), { path: "/api/disks/format", body: { name: "disk.img", label: "VIM4KVM", confirm: "disk.img", snapshot: true } });
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/disks-desktop.png`, fullPage: true });

  await page.getByRole("radio", { name: /tools\.img/ }).check({ force: true });
  await page.getByText(/The disk is mounted on the target computer/).waitFor();
  assert.equal(await page.getByRole("radio", { checked: true }).locator("..").getByText("Mounted on target computer").count(), 1);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(["x"], "x.txt"));
    document.querySelector('[aria-label="Files"]').dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await page.getByRole("region", { name: "Files", exact: true }).filter({ has: page.getByText(/The disk is mounted/) }).waitFor();
  assert.equal(await page.getByRole("region", { name: "Files", exact: true }).getAttribute("data-drop"), "The disk is mounted on the target computer. Eject it before uploading.");
  await page.evaluate(() => document.querySelector('[aria-label="Files"]').dispatchEvent(new DragEvent("drop", { dataTransfer: new DataTransfer(), bubbles: true, cancelable: true })));
  await page.getByRole("button", { name: /^readme\.txt/ }).click();
  assert.equal(await page.getByRole("button", { name: "Upload files" }).isDisabled(), true);
  await page.getByRole("button", { name: "Maintenance", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Format…" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Delete data disk…" }).isDisabled(), true);
  await page.getByRole("link", { name: "Download readme.txt" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Delete readme.txt" }).count(), 0, "attached disks hide file mutations");

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole("button", { name: "Open actions for readme.txt" }).click();
  assert(await page.getByRole("menuitem", { name: "Download readme.txt" }).isVisible());
  assert.equal(await page.getByRole("menuitem", { name: "Delete", exact: true }).count(), 0, "touch menu respects attached read-only state");
  await page.keyboard.press("Escape");
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/disks-mobile.png`, fullPage: true });
  failDisks = true;
  await page.reload();
  await page.getByText("Couldn't read the mount status").waitFor();
  assert.equal(await page.getByRole("button", { name: "Format…" }).count(), 0);
  failDisks = false;
  await page.getByRole("button", { name: "Refresh data disks" }).click();
  await page.getByRole("button", { name: "Maintenance", exact: true }).click();
  await page.getByRole("button", { name: "Format…" }).waitFor();
  await page.getByRole("button", { name: "Open actions for readme.txt" }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page.getByRole("alertdialog", { name: "Delete readme.txt" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open actions for readme.txt" }).evaluate(el => new Promise((resolve, reject) => {
    const start = performance.now();
    const check = () => document.activeElement === el ? resolve() : performance.now() - start > 2000 ? reject(new Error("file menu trigger did not regain focus")) : requestAnimationFrame(check);
    check();
  }));
  console.log("PASS: create, upload with leave guard, drop guard, folders, armed delete, snapshot delete, resize presets, format, attached lockout, read failure recovery and mobile layout");
} finally { await browser.close(); }
