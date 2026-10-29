import assert from "node:assert/strict";
import { authenticated } from "./auth-fixture.mjs";
import { fixtures } from "./ui-fixtures.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const { status } = fixtures();
const now = Date.now();
status.history = [25, 50, null, 100, 0].map((gpu, i) => ({
  t: now - (4 - i) * 5000, cpu: 10, gpu, mem: 20, tempC: 50, fan: 15, rxBps: 0, txBps: 0,
}));
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await (await import("./auth-fixture.mjs")).pinLanguage(page);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => route.fulfill({ status: 404, json: {} }));
  await page.route("**/api/status", route => route.fulfill({ json: status }));
  await authenticated(page);
  await page.goto(`${process.env.TEST_URL || "http://127.0.0.1:5188"}/#/overview`);
  const trends = page.locator("[data-trends]");
  await trends.getByRole("tab", { name: "GPU", exact: true }).waitFor();
  assert.deepEqual((await trends.getByRole("tab").allTextContents()).slice(0, 3), ["CPU", "GPU", "Memory"]);
  await trends.getByRole("tab", { name: "GPU", exact: true }).click();
  await trends.locator("[data-trend-value]").getByText("0%", { exact: true }).waitFor();
  const line = trends.locator("[data-chart=line]");
  await line.waitFor();
  assert.equal((await line.getAttribute("d")).split("M").length - 1, 2, "missing GPU interval splits the curve");
  assert.match(await trends.getByRole("img").getAttribute("aria-label"), /current 0%/);
  status.history.push({ ...status.history.at(-1), t: now + 5000, gpu: null });
  await page.reload();
  await trends.getByRole("tab", { name: "GPU", exact: true }).click();
  await trends.locator("[data-trend-value]").getByText("—", { exact: true }).waitFor();
  assert.equal(await trends.locator("[data-chart=dot]").count(), 0, "missing current reading hides stale dot");
  assert.match(await trends.getByRole("img").getAttribute("aria-label"), /current No data/);
  // Older APIs and kernels without the vendor attribute still render the tab.
  status.history = status.history.map(({ gpu, ...sample }) => sample);
  await page.reload();
  await trends.getByRole("tab", { name: "GPU", exact: true }).click();
  await trends.getByText("No GPU data", { exact: true }).waitFor();
  assert.equal(await line.getAttribute("d"), "", "unavailable GPU does not draw a zero-use curve");
  status.history = status.history.map(sample => ({ ...sample, gpu: 64 }));
  await page.reload();
  await trends.getByRole("tab", { name: "GPU", exact: true }).click();
  await trends.locator("[data-trend-value]").getByText("64%", { exact: true }).waitFor();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
  }
  assert.deepEqual(errors, []);
  console.log("PASS: GPU tab, idle/load, gaps, missing/old API, recovery and desktop/mobile layout");
} finally {
  await browser.close();
}
