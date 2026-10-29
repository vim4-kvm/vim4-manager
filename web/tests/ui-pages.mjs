// Offline review matrix, identical API data and interactions on origin/main and the refactor.
// node web/tests/ui-pages.mjs <base-url> <output-dir> [--after] [--phase3]
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fixtures, localizeResponse } from "./ui-fixtures.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const [base = "http://127.0.0.1:5188", out = "/tmp/ui-pages"] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const after = process.argv.includes("--after");
const click = (name) => async (page) => {
 const button=page.getByRole("button",{name,exact:true});
 if(name==="Format…" && !await button.isVisible()) await page.getByRole("button",{name:"Maintenance",exact:true}).click();
 await button.click();
};
const change = (name, value) => (page) => page.getByLabel(name, { exact: true }).fill(value);
const scenarios = [
  { name: "video-synced", page: "video", ready: "The selected preset is saved and loaded." },
  { name: "video-out-of-sync", page: "video", edit: (f) => { f.edid.jetkvmSynced = false; }, ready: "Apply again to sync JetKVM settings." },
  { name: "video-edid-confirm", page: "video", ready: "The selected preset is saved and loaded.", actions: [async (p) => p.getByRole("radio", { name: /VIM4 1080p60/ }).check(), click("Apply preset")] },
  { name: "video-read-error", page: "video", edit: (f) => { f.errors["/api/edid"] = "Read connection lost"; }, ready: "Couldn't load EDID: Read connection lost" },
  { name: "media-empty", page: "media", ready: "No media mounted" },
  { name: "media-mounted", page: "media", edit: (f) => { f.status.media.inserted = true; }, ready: "Mounted on target computer" },
  { name: "media-eject-confirm", page: "media", edit: (f) => { f.status.media.inserted = true; }, ready: "Mounted on target computer", actions: [click("Eject…")] },
  { name: "media-unknown", page: "media", edit: (f) => { f.status.media.known = false; }, ready: "Status unknown" },
  { name: "disks-files", page: "disks", ready: "readme.txt" },
  { name: "disks-create", page: "disks", ready: "readme.txt", actions: [click("Create data disk")] },
  { name: "disks-format-confirm", page: "disks", ready: "readme.txt", actions: [click("Format…")] },
  { name: "disks-attached", page: "disks", edit: (f) => { f.disks[0].attached = true; }, ready: "The disk is mounted on the target computer" },
  { name: "disks-empty", page: "disks", edit: (f) => { f.disks = []; }, ready: "No data disks yet." },
  { name: "disks-read-error", page: "disks", edit: (f) => { f.errors["/api/disks"] = "Couldn't read mount status"; }, ready: "Couldn't read mount status" },
  { name: "storage-connected", page: "storage", ready: "//192.168.50.2/video" },
  { name: "storage-empty", page: "storage", edit: (f) => { f.storage.storages = []; }, ready: "No NAS connections yet" },
  { name: "storage-add", page: "storage", ready: "//192.168.50.2/video", actions: [click("Add NAS")] },
  { name: "storage-folder", page: "storage", ready: "//192.168.50.2/video", actions: [click("Use as USB drive…")] },
  { name: "storage-read-only", page: "storage", edit: (f) => { f.storage.storages[0].writable = false; }, ready: "The board doesn't have write permission" },
  { name: "storage-stalled", page: "storage", edit: (f) => { f.storage.storages[0].stale = true; }, ready: "Connected · Not responding" },
  ...["scanning", "attached", "committing", "needs-decision", "failed"].map((state) => ({
    name: `storage-usb-${state}`, page: "storage", ready: "USB drive · 家庭 NAS", edit: (f) => {
      f.nasdisk.session = { ...f.nasSession, state,
        progress: state === "committing" ? { done: 3, total: 10, bytesDone: 2 ** 20, bytesTotal: 4 * 2 ** 20, current: "readme.txt" } : null,
        decision: state === "needs-decision" ? { reason: "The file system is incomplete", canForce: true } : null,
        error: state === "failed" ? "The NAS connection was interrupted" : "" };
    },
  })),
  { name: "apps-selected", page: "apps", ready: "Start at boot" },
  { name: "apps-switch-confirm", page: "apps", ready: "Start at boot", actions: [async (p) => p.getByRole("button", { name: "Switch to PiKVM", exact: true }).last().click()] },
  { name: "apps-wait-for-eject", page: "apps", edit: (f) => { f.status.media.inserted = true; }, ready: "Start at boot", actions: [async (p) => p.getByRole("button", { name: "Switch to PiKVM", exact: true }).last().click(), click("Switch after ejection")] },
  { name: "network-client", page: "network", ready: "Home" },
  { name: "network-join", page: "network", ready: "Office", actions: [async (p) => p.getByRole("button", { name: /Office/ }).click()] },
  { name: "network-hotspot", page: "network", ready: "Broadcasting", edit: (f) => { f.wifi.mode = "hotspot"; f.wifi.hotspot.active = true; } },
  { name: "network-hotspot-qr", page: "network", ready: "Broadcasting", edit: (f) => { f.wifi.mode = "hotspot"; f.wifi.hotspot.active = true; }, actions: [click("Scan to join hotspot")] },
  { name: "network-off", page: "network", edit: (f) => { f.wifi.enabled = false; f.wifi.mode = "off"; f.tailscale.installed = false; }, ready: "Install Tailscale" },
  { name: "network-login", page: "network", edit: (f) => { f.tailscale.backendState = "NeedsLogin"; f.tailscale.authURL = "https://login.tailscale.com/a/example"; }, ready: "Open sign-in page" },
  { name: "network-approval", page: "network", edit: (f) => { f.tailscale.backendState = "NeedsMachineAuth"; }, ready: "A tailnet administrator needs to approve" },
  { name: "network-installing", page: "network", edit: (f) => { f.tailscale.job = { action: "install", running: true }; }, ready: "Installing Tailscale…" },
  { name: "cooling-current", page: "cooling", ready: "Start temperature" },
  { name: "cooling-draft", page: "cooling", ready: "Start temperature", actions: [async (p) => p.getByRole("button", { name: /Cool/ }).click()] },
  { name: "cooling-invalid", page: "cooling", ready: "Start temperature", actions: [async (p) => p.getByRole("spinbutton", { name: /Start temperature/ }).fill("90")] },
  { name: "services-running", page: "services", ready: "vim4-hdmi.service" },
  { name: "services-failed", page: "services", edit: (f) => { f.status.platform[0].unit.active = "failed"; }, ready: "vim4-hdmi.service" },
  { name: "updates-available", page: "updates", ready: "Update to 1.4.1" },
  { name: "updates-install-confirm", page: "updates", ready: "Update to 1.4.1", actions: [click("Update")] },
  { name: "updates-kernel-confirm", page: "updates", ready: "Update to 1.4.1", actions: [click("Switch and restart")] },
  { name: "account-devices", page: "account", ready: "This device" },
  { name: "account-single", page: "account", edit: (f) => { f.account.sessions = f.account.sessions.slice(0, 1); }, ready: "Only this device" },
  { name: "account-read-error", page: "account", edit: (f) => { f.errors["/api/account/sessions"] = "Couldn't load signed-in devices"; }, ready: "Couldn't load signed-in devices" },
  { name: "account-password", page: "account", ready: "This device", actions: [click("Change password")] },
  { name: "account-logout-others", page: "account", ready: "This device", actions: [click("Sign out other devices")] },
  { name: "login", page: "login", ready: "Forgot password?" },
  { name: "login-forgot", page: "login", ready: "Forgot password?", actions: [click("Forgot password?")] },
  { name: "login-error", page: "login", ready: "Forgot password?", actions: [change("Password", "wrong-password"), click("Sign in")] },
  { name: "login-setup", page: "login", edit: (f) => { f.auth.configured = false; }, ready: "Create administrator account" },
  { name: "login-setup-blocked", page: "login", edit: (f) => { f.auth.configured = false; f.auth.setupAllowed = false; }, ready: "Set up on the local network" },
  { name: "login-load-error", page: "login", edit: (f) => { f.errors["/__vim4/api/auth/state"] = "offline"; }, ready: "Couldn't connect to the board. Check the network and try again." },
];

const finalPageStates = new Set(["video-synced", "media-mounted", "disks-files", "storage-connected", "apps-selected", "network-client", "cooling-current", "services-running", "updates-available", "account-devices", "login"]);
const captureScenarios = process.argv.includes("--phase3") ? [
  { name: "overview-final", page: "overview", ready: "Recent events" },
  { name: "output-final", page: "output", ready: "Passthrough active" },
  ...scenarios.filter((scenario) => finalPageStates.has(scenario.name)),
  { name: "output-read-stale", page: "output", ready: "Passthrough active", actions: [async (p, f) => {
    f.errors["/api/passthrough"] = "Read connection lost";
    await p.getByText("Couldn't refresh: Read connection lost. Showing the last known state.", { exact: true }).waitFor();
  }] },
  { name: "output-hdr-pending", page: "output", ready: "Passthrough active", edit: (f) => { f.pendingWrite = true; },
    actions: [async (p) => { await p.getByRole("switch", { name: "HDR", exact: true }).click(); await p.getByText("Switching…", { exact: true }).first().waitFor(); }] },
  { name: "disks-delete-confirm", page: "disks", ready: "readme.txt", actions: [async (p) => {
    await p.getByRole("button", { name: /^readme\.txt/ }).click();
    if (after && p.viewportSize().width < 768) {
      await p.getByRole("button", { name: "Open actions for readme.txt" }).click();
      await p.getByRole("menuitem", { name: "Delete", exact: true }).click();
    } else await p.getByRole("button", { name: "Delete readme.txt", exact: true }).click();
    await p.getByRole("alertdialog").waitFor();
  }] },
  ...(after ? [{ name: "disks-file-actions", page: "disks", ready: "readme.txt", actions: [async (p) => {
    if (p.viewportSize().width < 768) await p.getByRole("button", { name: "Open actions for readme.txt" }).click();
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
    if (after && scenario.name === "disks-files") {
      data.files.entries.push(...Array.from({ length: 16 }, (_, i) => ({ name: `fixture-${i}.txt`, dir: false, size: 1024, mtime: Date.now() / 1000 })));
    }
    scenario.edit?.(data);
    if (scenario.page === "login") data.auth.authenticated = false;
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: theme, reducedMotion: "reduce", locale: "zh-CN", timezoneId: "Asia/Shanghai" });
    await context.addInitScript((theme) => localStorage.setItem("vim4-manager-theme", theme), theme);
    await context.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === "POST" && data.pendingWrite) { data.pendingRoute = route; return; }
      if (data.errors[path]) return route.fulfill({ status: 503, json: { error: data.errors[path] } });
      if (path === "/__vim4/api/auth/login") return route.fulfill({ status: 401, json: { error: "Couldn't sign in. Check your username and password." } });
      const responses = {
        "/__vim4/api/auth/state": data.auth, "/api/status": data.status, "/api/edid": data.edid, "/api/media": data.media,
        "/api/disks": data.disks, "/api/disks/files": data.files, "/api/storage": data.storage, "/api/nasdisk": data.nasdisk,
        "/api/storage/dirs": { entries: [{ name: "工具" }, { name: "录像" }], truncated: false },
        "/api/wifi": data.wifi, "/api/wifi/networks": { networks: data.networks }, "/api/tailscale": data.tailscale,
        "/api/passthrough": data.passthrough, "/api/kernel": data.kernel, "/api/updates": data.updates, "/api/account/sessions": data.account,
      };
      return route.fulfill({ status: path in responses ? 200 : 404, json: localizeResponse(path, responses[path], route.request().headers().cookie) ?? { error: "Unexpected test API" } });
    });
    const page = await context.newPage();
  await (await import("./auth-fixture.mjs")).pinLanguage(page);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(scenario.page === "login" ? `${base}/__vim4/login` : `${base}/#/${scenario.page}`);
      await page.getByText(scenario.ready, { exact: false }).first().waitFor();
      for (const action of scenario.actions ?? []) await action(page, data);
      if (scenario.name === "storage-folder") await page.getByRole("button", { name: "工具", exact: true }).waitFor();
      if (scenario.name === "login-error") await page.getByText("Couldn't sign in. Check your username and password.", { exact: true }).waitFor();
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
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForFunction(() => scrollY > 0);
        const sidebar = await page.locator('[data-slot="sidebar-container"]').boundingBox();
        assert(await page.evaluate(() => scrollY) > 0, "sidebar evidence uses a genuinely scrolled viewport");
        assert(Math.abs(sidebar.y) < 1 && sidebar.height === 900, "sidebar fills the scrolled viewport");
        assert(await page.getByRole("button", {name:"Change appearance"}).isVisible());
        const scrolled = `sidebar-scrolled-${theme}-${width}.png`;
        await page.screenshot({ path: `${out}/${scrolled}`, fullPage: false, animations: "disabled" });
        captures.push(scrolled);
      }
    } finally { if (data.pendingRoute) await data.pendingRoute.abort().catch(() => {}); await context.close(); }
  }
  await writeFile(`${out}/manifest.json`, JSON.stringify({ base, baseline: "origin/main@fa088412c73c767a919441d96d4f9f6f9a31b12d", candidate: after ? "ui/shadcn-refactor" : "origin/main", themes: ["light", "dark"], widths: [1280, 390], captures }, null, 2) + "\n");
  console.log(`PASS: ${captures.length} offline screenshots in ${out}`);
} finally { await browser.close(); }
