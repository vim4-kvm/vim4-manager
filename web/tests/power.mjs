import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { authenticated } from "./auth-fixture.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const now = Date.now();
const status = {
  active: "", apps: [], platform: [],
  power: { vbusPresent: true, bootContract: { voltageV: 5, currentA: 3 } },
  hardware: { hostname: "vim4", kernel: "5.15.137", uptimeSeconds: 60, load1: 0, cpus: 8,
    memTotalKiB: 1024, memAvailableKiB: 512, tempC: 50, zones: [], fanAuto: true,
    fanPercent: 30, usb: "configured", hdmi: { signal: false, audio: false }, hdrCurve: { white: 203, peak: 1000 } },
  system: { links: [], disk: { totalBytes: 1, freeBytes: 1 }, packages: [] }, events: [],
  history: [0.5, 0.8, null, 0.2, 0].map((cpuPowerW, i) => ({
    t: now - (4 - i) * 5000, cpu: 10, mem: 50, tempC: 50, fan: 30, rxBps: 0, txBps: 0, cpuPowerW,
  })),
};
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce", timezoneId: "Pacific/Honolulu" });
  await (await import("./auth-fixture.mjs")).pinLanguage(page);
  const screenshots = process.env.SCREENSHOTS || "/tmp/codex-ui/pdcard";
  await mkdir(screenshots, { recursive: true });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/status", (route) => route.fulfill({ json: status }));
  await authenticated(page);
  await page.goto(`${process.env.TEST_URL || "http://127.0.0.1:5188"}/#/overview`);
  await page.getByText("5 V / 3 A", { exact: true }).waitFor();
  await page.getByText(/15 W budget/).waitFor();
  await page.getByRole("tab", {name:"Power",exact:true}).click();
  const chart = page.locator("figure").filter({ hasText: "CPU dynamic power (estimated)" });
  await chart.locator("[data-trend-value]").getByText("0.00 W", { exact: true }).waitFor();
  const line = chart.locator("[data-chart=line]");
  await line.waitFor();
  assert.equal(((await line.getAttribute("d")) || "").split("M").length - 1, 2, "missing interval splits the curve");
  await chart.getByRole("img").focus();
  await page.keyboard.press("ArrowLeft");
  await chart.locator("[data-chart=tooltip]").getByText("0.00 W", { exact: true }).waitFor();
  status.history.push({ ...status.history.at(-1), t: now + 5000, cpuPowerW: null });
  await page.reload();
  await page.getByRole("tab", {name:"Power",exact:true}).click();
  await chart.locator("[data-trend-value]").getByText("—", { exact: true }).waitFor();
  assert.equal(await chart.locator("[data-chart=dot]").count(), 0, "unavailable current sample does not show a stale last dot");
  assert.match(await chart.getByRole("img").getAttribute("aria-label"), /current\s*No data/);
  status.hardware.kernel = "7.3.0-rc7-vim4kvm-uhd1+";
  status.power.bootContract = null;
  status.history = status.history.map(sample => ({ ...sample, cpuPowerW: null, cpuPowerAvailable: false }));
  await page.reload();
  await page.getByRole("tab", {name:"Power",exact:true}).click();
  await page.getByText("USB-C voltage detected", { exact: true }).waitFor();
  await chart.getByText("Estimate unavailable", { exact: true }).waitFor();
  assert.equal(await chart.getByText("Sampling…", { exact: true }).count(), 0);
  assert.equal(await chart.getByText("No samples yet", { exact: true }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
  status.power.firmwarePD = {
    psReady: true, flags: 65, rp: "3A", sourceRevision: "2.0", requestRevision: "2.0",
    rdo: "14019096", selectedPosition: 1, selectedType: "Fixed",
    requestedCurrentA: 1, requestedMaxCurrentA: 1.5,
    contract: { voltageV: 5, currentA: 1.5 },
    sourceCapabilities: [
      { position: 1, raw: "3e01912c", type: "Fixed", minVoltageV: 5, maxVoltageV: 5, maxCurrentA: 3 },
      { position: 2, raw: "4f0190b4", type: "Battery", minVoltageV: 5, maxVoltageV: 12, maxPowerW: 45 },
      { position: 3, raw: "8f01912c", type: "Variable", minVoltageV: 5, maxVoltageV: 12, maxCurrentA: 3 },
      { position: 4, raw: "c0dc213c", type: "PPS", minVoltageV: 3.3, maxVoltageV: 11, maxCurrentA: 3 },
    ],
  };
  await page.reload();
  await page.getByRole("tab", {name:"Power",exact:true}).click();
  await page.getByText("PD · 5V 1.5A", { exact: true }).waitFor();
  await page.getByText("7.5 W budget · Firmware", { exact: true }).waitFor();
  await page.getByText("Source capabilities · 4 entries", { exact: true }).click();
  await page.getByText("Fixed · 5V 3A", { exact: true }).waitFor();
  await page.getByText("PPS · 3.3–11V 3A", { exact: true }).waitFor();
  await page.getByText("0x3e01912c", { exact: true }).waitFor();
  await page.getByText("Operating request 1 A · Maximum request 1.5 A", { exact: true }).waitFor();
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
  await page.screenshot({ path: `${screenshots}/r2-firmware-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
  await page.screenshot({ path: `${screenshots}/r2-firmware-1280.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  status.hardware.kernel = "5.15.137-vim4kvm";
  status.power.bootContract = { voltageV: 5, currentA: 3 };
  await page.reload();
  await page.getByRole("tab", {name:"Power",exact:true}).click();
  await page.getByText("5 V / 3 A", { exact: true }).waitFor();
  await page.getByText("15 W budget · Linux", { exact: true }).waitFor();
  await page.getByText("Source capabilities · 4 entries", { exact: true }).click();
  await page.getByText("Boot firmware · 5 V 1.5 A", { exact: true }).waitFor();
  status.power.bootContract = null;
  Object.assign(status.power.firmwarePD, { psReady: false, contract: null, typecFallback: true, hardReset: true, timedOut: true, rp: "default" });
  await page.reload();
  await page.getByRole("tab", {name:"Power",exact:true}).click();
  await page.getByText("Type-C · No confirmed PD contract", { exact: true }).waitFor();
  await page.getByText("Boot firmware · Rp Default current", { exact: true }).waitFor();
  await page.getByText("Source capabilities · 4 entries", { exact: true }).click();
  await page.getByText("Hard reset · Initialization timed out", { exact: true }).waitFor();
  assert.equal(await page.getByText(/PD · 5V/).count(), 0);
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
  const tile = page.locator('div:has(> dt)').filter({ has: page.locator('dt', { hasText: /^USB-C power$/ }) });
  const boardYear = new Date().getUTCFullYear();
  status.power.firmwarePD.sourceCapabilities = [];
  Object.assign(status.power.firmwarePD, { rp: "3A", hardReset: false });
  status.power.lastContract = { voltageV: 5, currentA: 3, usbComm: true, rdo: "1304b12c",
    origin: "linux", bootId: "previous", establishedAt: `${boardYear}-01-02T03:04:05+08:00` };
  async function captureWidths(name) {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
      // The main value may wrap but is never clipped or ellipsized.
      const metrics = await tile.locator('dd').first().evaluate(el => ({
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, textOverflow: getComputedStyle(el).textOverflow,
      }));
      assert(metrics.clientWidth > 0 && metrics.scrollWidth <= metrics.clientWidth,
        `${name} at ${width}px must show its full main value: ${JSON.stringify(metrics)}`);
      assert.notEqual(metrics.textOverflow, 'ellipsis');
      await chart.getByText("Estimate unavailable", { exact: true }).waitFor();
      assert.equal(await chart.getByText("No samples yet", { exact: true }).count(), 0);
      assert.equal(await chart.locator('[data-chart=empty]').count(), 1);
      await page.screenshot({ path: `${screenshots}/r2-${name}-${width}.png`, fullPage: true });
      if (name === 's4') await chart.screenshot({ path: `${screenshots}/r2-power-empty-${width}.png` });
    }
  }
  async function checkWarm(name, value, detail, secondLine) {
    await page.reload();
  await page.getByRole("tab", {name:"Power",exact:true}).click();
    await tile.getByText(value, { exact: true }).waitFor();
    assert.equal(await tile.locator('dd[title]').getAttribute('title'), detail);
    assert.equal(await tile.locator('dd').first().innerText(), value);
    await tile.getByText("Source capabilities · Not received this boot", { exact: true }).click();
    assert.deepEqual(await tile.locator('[data-pd-capabilities] p').allTextContents(), [
      "Timed out waiting for source capabilities; the source may not resend them after a warm restart.", secondLine,
      "Boot negotiation record; does not measure live current or power",
    ]);
    assert.equal(await tile.locator('ul').count(), 0);
    assert.equal(await tile.locator('[data-tone]').count(), 0);
    await captureWidths(name);
  }
  await checkWarm('s3', "5 V 3 A · Retained", "Not renegotiated · Previous Jan 2, 03:04",
    "Previous contract · 5 V 3 A · USB data · Linux · Jan 2, 03:04");
  // Earlier year, firmware origin and no USB comm use board time despite browser zone.
  Object.assign(status.power.lastContract, { establishedAt: `${boardYear - 1}-12-31T23:59:00+08:00`,
    origin: 'firmware', usbComm: false });
  await checkWarm('s3-previous-year', "5 V 3 A · Retained", `Not renegotiated · Previous Dec 31, ${boardYear - 1}, 23:59`,
    `Previous contract · 5 V 3 A · Firmware · Dec 31, ${boardYear - 1}, 23:59`);
  delete status.power.lastContract;
  await checkWarm('s4', "Type-C only", "Not renegotiated · Rp 3A", "Reconnect USB-C power to read the full negotiation");
  Object.assign(status.power.firmwarePD, { hardReset: true, requestFailed: true, ioError: true });
  await page.reload();
  await page.getByRole("tab", {name:"Power",exact:true}).click();
  await tile.getByText("Source capabilities · Not received this boot", { exact: true }).click();
  await tile.getByText("Hard reset · Request failed or deferred · Read failed", { exact: true }).waitFor();
  assert.equal(await tile.getByText(/Initialization timed out|PD contract incomplete/).count(), 0);
  Object.assign(status.power.firmwarePD, { timedOut: false, hardReset: false, requestFailed: false, ioError: false });
  await page.reload();
  await page.getByRole("tab", {name:"Power",exact:true}).click();
  await tile.getByText("Type-C · No confirmed PD contract", { exact: true }).waitFor();
  await tile.getByText("Source capabilities · Not received this boot", { exact: true }).click();
  await tile.getByText("Boot firmware · PD contract incomplete", { exact: true }).waitFor();
  assert.equal(await tile.getByText("Reconnect USB-C power to read the full negotiation", { exact: true }).count(), 0);
  await captureWidths('s5-empty-pdo');
  // Empty charts all use the same component; none should layer two placeholders.
  status.history = [];
  await page.reload();
  await page.getByRole("tab", {name:"Power",exact:true}).click();
  await chart.getByText("Sampling…", { exact: true }).waitFor();
  const emptyCharts = await page.locator('[data-trends] figure').all();
  assert.equal(emptyCharts.length, 1, "the active metric uses the shared empty chart");
  for (const figure of emptyCharts) {
    assert.equal(await figure.locator('[data-chart=empty]').count(), 1);
    assert.equal(await figure.getByText("No samples yet", { exact: true }).count(), 0);
    await figure.getByText("Sampling…", { exact: true }).waitFor();
  }
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.screenshot({ path: `${screenshots}/r2-empty-charts-${width}.png`, fullPage: true });
  }
  assert.deepEqual(errors, [], "no browser exceptions");
  console.log("PASS: S1–S5 exact text, full main values at 390/1280px, board-local time, CPU watts and one placeholder per empty chart");
} finally {
  await browser.close();
}
