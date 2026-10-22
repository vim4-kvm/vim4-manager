import assert from "node:assert/strict";
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/status", (route) => route.fulfill({ json: status }));
  await authenticated(page);
  await page.goto(`${process.env.TEST_URL || "http://127.0.0.1:5188"}/#/overview`);
  await page.getByText("5 V / 3 A", { exact: true }).waitFor();
  await page.getByText(/供电额度 15 W/).waitFor();
  const chart = page.locator("figure").filter({ hasText: "CPU 动态功耗（估算）" });
  await chart.getByText("0.00 W", { exact: true }).waitFor();
  const line = chart.locator(".chart-line");
  await line.waitFor();
  assert.equal(((await line.getAttribute("d")) || "").split("M").length - 1, 2, "missing interval splits the curve");
  await chart.getByRole("img").focus();
  await page.keyboard.press("ArrowLeft");
  await chart.locator(".chart-tooltip").getByText("0.00 W", { exact: true }).waitFor();
  status.history.push({ ...status.history.at(-1), t: now + 5000, cpuPowerW: null });
  await page.reload();
  await chart.getByText("—", { exact: true }).waitFor();
  assert.equal(await chart.locator(".chart-dot").count(), 0, "unavailable current sample does not show a stale last dot");
  assert.match(await chart.getByRole("img").getAttribute("aria-label"), /当前\s*暂无数据/);
  status.hardware.kernel = "7.3.0-rc7-vim4kvm-uhd1+";
  status.power.bootContract = null;
  status.history = status.history.map(sample => ({ ...sample, cpuPowerW: null, cpuPowerAvailable: false }));
  await page.reload();
  await page.getByText("已检测到 USB-C 电压", { exact: true }).waitFor();
  await chart.getByText("暂无法估算", { exact: true }).waitFor();
  assert.equal(await chart.getByText("正在采样…", { exact: true }).count(), 0);
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
  await page.getByText("PD 合同 · 5V 1.5A", { exact: true }).waitFor();
  await page.getByText("供电额度 7.5 W · 启动固件协商", { exact: true }).waitFor();
  await page.getByText("来源能力 · 4 项", { exact: true }).click();
  await page.getByText("Fixed · 5V 3A", { exact: true }).waitFor();
  await page.getByText("PPS · 3.3–11V 3A", { exact: true }).waitFor();
  await page.getByText("0x3e01912c", { exact: true }).waitFor();
  await page.getByText("工作请求 1A · 最大请求 1.5A", { exact: true }).waitFor();
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/power-phone.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/power-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  status.hardware.kernel = "5.15.137-vim4kvm";
  status.power.bootContract = { voltageV: 5, currentA: 3 };
  await page.reload();
  await page.getByText("5 V / 3 A", { exact: true }).waitFor();
  await page.getByText("供电额度 15 W · Linux 初始化", { exact: true }).waitFor();
  await page.getByText("来源能力 · 4 项", { exact: true }).click();
  await page.getByText("启动固件 · 5V 1.5A", { exact: true }).waitFor();
  status.power.bootContract = null;
  Object.assign(status.power.firmwarePD, { psReady: false, contract: null, typecFallback: true, hardReset: true, timedOut: true, rp: "default" });
  await page.reload();
  await page.getByText("Type-C · 无确认的 PD 合同", { exact: true }).waitFor();
  await page.getByText("启动固件 · Rp 默认电流", { exact: true }).waitFor();
  await page.getByText("来源能力 · 4 项", { exact: true }).click();
  await page.getByText("发生硬复位 · 初始化超时", { exact: true }).waitFor();
  assert.equal(await page.getByText(/PD 合同 · 5V/).count(), 0);
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
  assert.deepEqual(errors, [], "no browser exceptions");
  console.log("PASS: PD request vs PDO rating, Linux priority, legacy fallback, hard reset, source capabilities, CPU watts and 390px layout");
} finally {
  await browser.close();
}
