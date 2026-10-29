// Full localization review matrix, using only the local screen fixtures.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fixtures, localizeResponse } from "./ui-fixtures.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.TEST_URL || "http://127.0.0.1:5188";
const out = process.env.I18N_SCREEN_DIR || "/tmp/i18n-codex/final3";
const pages = ["overview", "apps", "media", "disks", "storage", "video", "output", "cooling", "network", "services", "updates", "account", "login"];
const forms = { media: "/api/media", disks: "/api/disks", storage: "/api/storage", video: "/api/edid", output: "/api/passthrough", network: "/api/wifi", updates: "/api/updates", account: "/api/account/sessions" };
const matrix = pages.flatMap(page => ["en", "zh-CN"].flatMap(locale => [
  [page, locale, 1440, "light"], [page, locale, 1440, "dark"], [page, locale, 390, "light"],
]));
matrix.push(...["en", "zh-CN"].flatMap(locale => ["light", "dark"].map(theme => ["overview", locale, 1280, theme])));
matrix.push(...["overview", "login"].flatMap(page => ["en", "zh-CN"].flatMap(locale => ["light", "dark"].map(theme => [page, locale, 1440, theme, "menu"]))));
matrix.push(...pages.flatMap(page => ["error", "empty"].map(state => [page, "en", 1440, "light", state])));
// Retain the Chinese validation-state coverage from the original matrix.
matrix.push(["cooling", "zh-CN", 1440, "light", "error"]);

function screenData(page, locale, state) {
  const data = fixtures(locale);
  const zh = locale === "zh-CN";
  data.auth.authenticated = page !== "login";
  data.storage.storages[0].name = zh ? "家庭 NAS" : "Home NAS";
  data.nasSession.storageName = data.storage.storages[0].name;
  data.nasSession.path = "/tools";
  const now = Date.now();
  data.status.history = Array.from({ length: 181 }, (_, i) => ({
    t: now - (180 - i) * 5000, cpu: 15 + 8 * Math.sin(i / 9), mem: 21,
    tempC: 52.4 + Math.sin(i / 30), fan: 30, rxBps: 60000,
    txBps: 9e6 + 2e6 * Math.sin(i / 11), cpuPowerW: 0.5, cpuPowerAvailable: true,
  }));
  data.status.events = [
    { t: now - 60000, tone: "good", message: { key: "events.hdmiRestored", args: { p0: "3840×2160@60" } } },
    { t: now - 120000, tone: "good", message: { key: "events.usbConnected" } },
    { t: now - 180000, tone: "idle", message: { key: "events.managerStarted" } },
  ];
  if (state === "error" && ["overview", "apps", "services"].includes(page)) {
    data.status.platform[0].unit.active = "failed";
    data.status.apps.find(app => app.id === data.status.active).unit.active = "failed";
    data.status.hardware.hdmi.signal = false;
    data.status.events = [{ t: now, tone: "critical", message: { key: "events.hdmiLost" } }];
  }
  if (state !== "empty") return data;
  switch (page) {
    case "media": data.media = []; break;
    case "disks": data.disks = []; break;
    case "storage": data.storage.storages = []; break;
    case "updates": data.updates = []; data.kernel.kernels = []; break;
    case "account": data.account.sessions = []; break;
    case "login": data.auth.configured = false; data.auth.setupAllowed = false; break;
    case "video": data.edid.presets = []; data.status.hardware.hdmi.signal = false; break;
    case "output": data.passthrough = { supported: true, enabled: true, audio: true, hdr: true, state: "no-monitor" }; break;
    case "overview":
    case "apps":
      data.status.apps = [];
      data.status.active = "";
      data.status.events = [];
      data.status.history = [];
      data.status.hardware.hdmi.signal = false;
      data.status.media.inserted = false;
      break;
    case "cooling": delete data.status.hardware.fanTriggers; data.status.hardware.zones = []; break;
    case "network":
      data.status.system.links = [];
      data.wifi = { supported: false, enabled: false, hardwareEnabled: false, saved: [], hotspot: data.wifi.hotspot };
      data.tailscale.devices = [];
      data.tailscale.peers = data.tailscale.peersOnline = 0;
      break;
    case "services": data.status.apps = []; data.status.platform = []; break;
  }
  return data;
}

async function mockAPI(context, data, page, state) {
  const responses = {
    "/__vim4/api/auth/state": data.auth, "/api/status": data.status, "/api/edid": data.edid, "/api/media": data.media,
    "/api/disks": data.disks, "/api/disks/files": data.files, "/api/storage": data.storage, "/api/nasdisk": data.nasdisk,
    "/api/storage/dirs": { entries: [], truncated: false }, "/api/wifi": data.wifi,
    "/api/wifi/networks": { networks: data.networks }, "/api/tailscale": data.tailscale,
    "/api/passthrough": data.passthrough, "/api/kernel": data.kernel, "/api/updates": data.updates, "/api/account/sessions": data.account,
  };
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(base).origin) return route.abort();
    if (!url.pathname.includes("/api/")) return route.continue();
    if (url.pathname === "/__vim4/api/auth/login") return route.fulfill({ status: 401, json: { error: "Couldn't sign in. Check your username and password." } });
    if (state === "error" && url.pathname === forms[page]) return route.fulfill({ status: 503, json: { error: "Couldn't load settings. Check the connection and try again." } });
    return route.fulfill({ status: url.pathname in responses ? 200 : 404, json: localizeResponse(url.pathname, responses[url.pathname], route.request().headers().cookie) ?? { error: "Unexpected fixture API" } });
  });
}

async function layoutProblems(page) {
  return page.evaluate(() => {
    const problems = [];
    for (const el of document.querySelectorAll("body *")) {
      if (!(el instanceof HTMLElement) || !el.innerText.trim() || !el.clientWidth || !el.getClientRects().length || el.closest("[class*=sr-only]")) continue;
      // Container extents can include switch hit-target pseudo-elements.
      // Inspect text-bearing elements and controls rather than their ancestors.
      const button = el.matches("button, [role=button], [data-slot=button]");
      if (!button && ![...el.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) continue;
      if (["auto", "scroll"].includes(getComputedStyle(el).overflowX)) continue;
      if (el.scrollWidth > el.clientWidth + 1) problems.push(`Text overflow: ${el.innerText.slice(0, 100)}`);
      if (!button) continue;
      const bounds = el.getBoundingClientRect();
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        if (!["hidden", "clip"].includes(getComputedStyle(parent).overflowX)) continue;
        const clip = parent.getBoundingClientRect();
        if (bounds.left < clip.left - 1 || bounds.right > clip.right + 1) {
          problems.push(`Clipped button: ${el.innerText.trim()}`);
          break;
        }
      }
    }
    if (document.documentElement.scrollWidth > innerWidth) problems.push("Document overflow");
    return problems;
  });
}

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
try {
  for (const [pageId, locale, width, theme, state] of matrix) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: theme, reducedMotion: "reduce", locale });
    await context.addInitScript(({ locale, theme }) => {
      localStorage.setItem("vim4-manager-language", locale);
      localStorage.setItem("vim4-manager-theme", theme);
    }, { locale, theme });
    await mockAPI(context, screenData(pageId, locale, state), pageId, state);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const viewport = width === 390 ? "mobile" : width === 1280 ? "desktop1280" : "desktop";
    const name = `${pageId}-${locale}-${viewport}-${theme}${state ? `-${state}` : ""}.png`;
    try {
      await page.goto(`${base}/${pageId === "login" ? "__vim4/login" : `#/${pageId}`}`);
      await page.getByRole("button", { name: /Language/ }).waitFor();
      if (pageId === "login" && state !== "empty") await page.locator("#username").waitFor();
      else if (pageId !== "login") await page.locator("#page-title").waitFor();
      if (width === 1280) assert.equal(await page.locator("header button[aria-expanded]").first().getAttribute("aria-expanded"), "true", "1280px overview keeps the sidebar expanded");
      if (pageId === "cooling" && state === "error") {
        await page.getByRole("spinbutton").first().fill("20");
        await page.getByRole("alert").waitFor();
      }
      if (pageId === "login" && state === "error") {
        await page.locator("#username").fill("admin");
        await page.locator("#password").fill("wrong-password");
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await page.getByRole("alert").waitFor();
      }
      if (state === "menu") {
        await page.getByRole("button", { name: /Language/ }).click();
        await page.getByRole("menuitemradio", { name: "English", exact: true }).waitFor();
      }
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        for (const animation of document.getAnimations()) {
          if (animation.effect?.getTiming().iterations !== Infinity) animation.finish();
        }
      });
      assert.deepEqual(errors, [], name);
      await page.locator("img").evaluateAll(async images => {
        await Promise.all(images.map(image => image.decode()));
      });
      assert.deepEqual(await page.locator("img").evaluateAll(images => images.filter(image => image.naturalWidth === 0).map(image => image.src)), [], "All images decode");
      const problems = await layoutProblems(page);
      if (locale === "en") {
        const joins = await page.evaluate(() => {
          const allowed = /^(?:VIM4|One-KVM|NanoKVM|JetKVM|PiKVM|MagicDNS|macOS|SoC|KiB|MiB|GiB|TiB|GitHub|iOS|vim4|kB|MB|GB|TB|Mbps|Gbps|kvm|eth\d+|wlan\d+|usb\d+|readme\.txt|H\.26[45]|BT\.2020|YCbCr|YUV\d+|HDR\d+|SDR|DELL|U2723QE|RTK|UHD|4K60|1080p60|PS_RDY|VIM4KVM)$/;
          return [...document.querySelectorAll("main *")].flatMap(el => {
            if (!(el instanceof HTMLElement) || !el.clientWidth || el.closest("code, input, [class*=font-mono], [class*=sr-only], svg")) return [];
            const text = el.innerText.trim();
            const words = text.split(/\s+/).filter(word => /[a-z][A-Z0-9]|:\S/.test(word));
            return words.filter(word => !allowed.test(word.replace(/^[+(]|[),.;]$/g, "")) && !/https?:|localhost:|\d:\d|\d+\.\d+|@|\.img|\.iso|\.service|vim4-|tail1234|--|\/|^\d+[KMG]$/.test(word)).map(word => ({ text, word }));
          });
        });
        assert.deepEqual(joins, [], "Joined label/value text");
      }
      await page.screenshot({ path: `${out}/${name}`, fullPage: true, animations: "disabled" });
      results.push({ name, problems });
      console.log(name, JSON.stringify(problems));
    } catch (error) {
      results.push({ name, error: error.message });
      console.log("FAIL", name, error.message);
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  await writeFile(`${out}/manifest.json`, JSON.stringify(results, null, 2));
  await writeFile(`${out}/index.md`, "# Final localization review\n\nDesktop 1440×900; mobile 390×844; overview also 1280×900 with the sidebar expanded. Both locales, light/dark desktop, light mobile, open language menus, and English error/empty states. Chinese cooling validation coverage is retained. All API data is mocked and external requests are aborted.\n\n" + results.map(result => `- [${result.name}](${result.name})${result.error ? ` — FAILED: ${result.error}` : result.problems.length ? ` — ${result.problems.join("; ")}` : ""}`).join("\n") + "\n");
}
assert.equal(results.length, matrix.length);
assert.deepEqual(results.filter(result => result.error || result.problems.length), [], "screen captures, text overflow, and clipped button labels");
console.log(`PASS: ${results.length} screenshots with no text overflow or clipped button labels; ${out}/index.md`);
