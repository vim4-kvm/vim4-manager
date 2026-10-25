// Captures review screenshots of migrated pages from mocked APIs.
// Usage: node web/tests/ui-screens.mjs <base-url> <output-dir> [--after]
// `--after` adds states that only exist in the new shell (the mobile Sheet).
import { mkdir } from "node:fs/promises";
import { authenticated } from "./auth-fixture.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const [base = "http://127.0.0.1:5188", out = "/tmp/ui-screens"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const after = process.argv.includes("--after");
await mkdir(out, { recursive: true });

const now = Date.now();
const history = Array.from({ length: 181 }, (_, i) => ({
  t: now - 15 * 60000 + i * 5000,
  cpu: 9 + 6 * Math.sin(i / 9) + (i % 7 === 0 ? 14 : 0),
  mem: 21 + Math.sin(i / 40) * 2,
  tempC: 51 + Math.sin(i / 30) * 2.5,
  fan: 30,
  rxBps: 60000 + 20000 * Math.sin(i / 5),
  txBps: 9.2e6 + 2.1e6 * Math.sin(i / 11),
  cpuPowerW: 0.42 + 0.18 * Math.sin(i / 9),
  cpuPowerAvailable: true,
}));
const overview = {
  active: "onekvm",
  apps: [{ id: "onekvm", name: "One-KVM", port: 8080, description: "",
    unit: { name: "one-kvm.service", loaded: true, active: "active", sub: "running", enabled: "enabled", since: new Date(now - 3 * 3600e3 - 12 * 60e3).toISOString() } }],
  platform: [], media: { known: true, inserted: false, connected: false },
  power: { vbusPresent: true, bootContract: { voltageV: 12, currentA: 3 } },
  hardware: { hostname: "vim4", kernel: "7.3.0-vim4kvm-uhd1+", uptimeSeconds: 3 * 86400 + 5 * 3600, load1: 0.42, cpus: 8,
    memTotalKiB: 8000000, memAvailableKiB: 6300000, tempC: 52.4, zones: [], fanAuto: true, fanPercent: 30, usb: "configured",
    hdmi: { signal: true, audio: true, width: 3840, height: 2160, captureWidth: 3840, captureHeight: 2160, refreshHz: 60, colorSpace: "YUV444", hdr: "SDR" },
    hdrCurve: { white: 203, peak: 1000 } },
  system: {
    links: [
      { name: "eth0", up: true, speedMbps: 1000, addrs: ["192.168.50.210", "fe80::1"] },
      { name: "wlan0", up: false, wireless: true, addrs: [] },
      { name: "usb0", up: true, addrs: ["10.0.0.1"] },
    ],
    disk: { totalBytes: 29.1 * 2 ** 30, freeBytes: 17.6 * 2 ** 30 },
    packages: [
      { name: "vim4-onekvm", version: "2.5.1+vim4.20261018.32" },
      { name: "vim4-manager", version: "1.4.0+vim4.20261024.3" },
    ],
  },
  events: [
    { t: now - 4 * 60e3, tone: "good", text: "HDMI 输入恢复：3840×2160 60 Hz" },
    { t: now - 4.2 * 60e3, tone: "warning", text: "HDMI 输入无信号" },
    { t: now - 31 * 60e3, tone: "good", text: "已切换到 One-KVM" },
    { t: now - 52 * 60e3, tone: "good", text: "USB 键鼠已连接" },
  ],
  history,
};

const input = { width: 3840, height: 2160, refreshHz: 60, hdr: "HDR10", colorFormat: "YCbCr 4:4:4", audio: true };
const monitor = { name: "DELL U2723QE", maxWidth: 3840, maxHeight: 2160, maxRefreshHz: 60, hdr: true, audio: true };
const output = { width: 3840, height: 2160, refreshHz: 60, colorFormat: "YCbCr 4:2:0 limited", scaled: false, hdrToSdr: false };
function passthrough(name) {
  const base = { supported: true, enabled: true, audio: true, hdr: true, state: "running", audioState: "running",
    input: { ...input }, monitor: { ...monitor }, output: { ...output } };
  switch (name) {
    case "running-hdr": return base;
    case "sdr-converted": return { ...base, hdr: false, output: { ...output, hdrToSdr: true } };
    case "off": return { ...base, enabled: false, state: "off", output: undefined, audioState: "off" };
    case "no-monitor": return { ...base, state: "no-monitor", monitor: undefined, output: undefined, audioState: "waiting" };
    case "no-signal": return { ...base, state: "no-signal", input: undefined, output: undefined, audioState: "waiting" };
    case "starting": return { ...base, state: "starting", audioState: "starting" };
    case "stopping": return { ...base, state: "stopping", audioState: "off" };
    case "protected": return { ...base, state: "protected", output: undefined };
    case "unsupported-format": return { ...base, state: "unsupported-format", input: { ...input, hdr: "Dolby Vision" }, output: undefined };
    case "video-error": return { ...base, state: "video-error", output: undefined };
    case "scaled": return { ...base, input: { ...input, hdr: "SDR" }, output: { ...output, width: 1920, height: 1080, refreshHz: 59.94, scaled: true } };
    case "hdr-no-support": return { ...base, monitor: { ...monitor, hdr: false }, output: { ...output, hdrToSdr: true } };
    case "hdr-sdr-input": return { ...base, input: { ...input, hdr: "SDR" } };
    case "audio-unavailable": return { ...base, audioState: "error" };
    case "unsupported": return { supported: false, enabled: false, audio: true, hdr: true, state: "unsupported" };
    default: return base;
  }
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
let state = passthrough("running-hdr");
let writeError = false;

async function open(theme, width, hash) {
  const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 900 }, reducedMotion: "reduce",
    colorScheme: theme, deviceScaleFactor: width < 768 ? 2 : 1 });
  await context.addInitScript((value) => localStorage.setItem("vim4-manager-theme", value), theme);
  await context.route("**/api/**", (route) => route.fulfill({ status: 404, json: { error: "Unexpected test API" } }));
  await context.route("**/api/status", (route) => {
    const hdmi = state.input ? { signal: true, ...state.input, colorSpace: state.input.colorFormat } : { signal: false, audio: false };
    const hardware = hash === "#/output" ? { ...overview.hardware, hdmi } : overview.hardware;
    return route.fulfill({ json: { ...overview, hardware, passthrough: state } });
  });
  await context.route("**/api/account/sessions", (route) => route.fulfill({ json: { sessions: [{ current: true, address: "192.168.50.12" }] } }));
  await context.route("**/api/passthrough", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: state });
    if (writeError) return route.fulfill({ status: 500, json: { error: "HDR 设置未能应用，请稍后重试" } });
    return route.fulfill({ json: { ...state, ...route.request().postDataJSON() } });
  });
  await authenticated(context);
  const page = await context.newPage();
  await page.goto(`${base}/${hash}`);
  return { context, page };
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => setTimeout(resolve, 400));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

const shots = [];
async function capture(page, name) {
  await settle(page);
  // Grow the viewport to the document so the fixed sidebar spans the capture.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const size = page.viewportSize();
  if (height > size.height) await page.setViewportSize({ width: size.width, height });
  await settle(page);
  const path = `${out}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  shots.push(path);
}

try {
  for (const theme of ["light", "dark"]) {
    for (const width of [1280, 390]) {
      const device = width < 768 ? "390" : "1280";
      const { context, page } = await open(theme, width, "#/overview");
      await page.getByText("最近事件").first().waitFor();
      await page.getByRole("img", { name: /CPU 使用率/ }).waitFor();
      await capture(page, `overview-${theme}-${device}`);
      await context.close();

      for (const name of ["running-hdr", "sdr-converted", "off", "no-monitor", "no-signal", "unsupported", "starting", "stopping", "protected", "unsupported-format", "video-error", "scaled", "hdr-no-support", "hdr-sdr-input", "audio-unavailable"]) {
        state = passthrough(name);
        const { context, page } = await open(theme, width, "#/output");
        await page.getByRole("switch", { name: "透传", exact: true }).waitFor();
        await capture(page, `output-${name}-${theme}-${device}`);
        await context.close();
      }

      state = passthrough("running-hdr");
      writeError = true;
      {
        const { context, page } = await open(theme, width, "#/output");
        const hdr = page.getByRole("switch", { name: "HDR", exact: true });
        await hdr.waitFor();
        await page.waitForFunction(() => !document.querySelector('[role="switch"][aria-label="HDR"]')?.disabled);
        await hdr.click();
        await page.getByText("保存 HDR 设置失败：HDR 设置未能应用，请稍后重试", { exact: true }).first().waitFor();
        await page.waitForFunction(() => !document.querySelector('[role="switch"][aria-label="HDR"]')?.disabled);
        await capture(page, `output-save-failure-${theme}-${device}`);
        await context.close();
      }
      writeError = false;

      if (after && width < 768) {
        const { context, page } = await open(theme, width, "#/output");
        await page.getByRole("switch", { name: "透传", exact: true }).waitFor();
        await page.getByRole("button", { name: "打开菜单" }).click();
        await page.getByRole("dialog").getByRole("navigation", { name: "页面" }).waitFor();
        await settle(page);
        await page.screenshot({ path: `${out}/output-sheet-open-${theme}-${device}.png` });
        shots.push(`${out}/output-sheet-open-${theme}-${device}.png`);
        await context.close();
      }
    }
  }
  console.log(`${shots.length} screenshots in ${out}`);
} finally {
  await browser.close();
}
