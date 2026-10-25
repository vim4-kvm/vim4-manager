import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const now = Date.now();
const history = (minutes, cpu = 13) => Array.from({ length: minutes * 12 + 1 }, (_, i) => ({
  t: now - minutes * 60000 + i * 5000, cpu: i % 2 ? 1 : cpu,
  mem: 16, tempC: 52, fan: 15, rxBps: 7000, txBps: 79000, cpuPowerW: 0.36,
}));
const status = {
  active: "onekvm", apps: [{ id: "onekvm", name: "One-KVM", port: 8080,
    unit: { loaded: true, active: "active", sub: "running", since: new Date(now - 60000).toISOString() } }], platform: [],
  power: { vbusPresent: true, bootContract: { voltageV: 5, currentA: 3 } },
  hardware: { hostname: "vim4", kernel: "5.15.137", uptimeSeconds: 65000, load1: 0.28, cpus: 8,
    memTotalKiB: 8000000, memAvailableKiB: 6720000, tempC: 52, zones: [], fanAuto: true,
    fanPercent: 15, usb: "configured", hdmi: { signal: true, audio: true, width: 3840, height: 2160,
      captureWidth: 3840, captureHeight: 2160, refreshHz: 59.98, colorSpace: "YUV444", hdr: "SDR" },
    hdrCurve: { white: 203, peak: 1000 } },
  system: { links: [{ name: "eth0", up: true, speedMbps: 1000, addrs: ["192.168.50.210"] }],
    disk: { totalBytes: 30000000000, freeBytes: 15000000000 },
    packages: [{ name: "vim4-onekvm", version: "2.5.1+vim4.20261018.32.dev.4.gabcdef0.dirty" }] },
  events: [], history: history(3),
};
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await page.route("**/api/**", (route) => route.fulfill({ status: 404, json: {} }));
  await page.route("**/api/status", (route) => route.fulfill({ json: status }));
  await (await import("./auth-fixture.mjs")).authenticated(page);
  const charts = page.locator("[data-trends] figure");
  const fact = (label) => page.locator("div:has(> dt)").filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }) });
  const reload = async () => {
    await page.goto(`${process.env.TEST_URL || "http://127.0.0.1:5188"}/#/overview`);
    await page.reload();
    await charts.locator("svg").last().waitFor();
  };
  await reload();
  await page.getByText(/已采样 3 分钟/).waitFor();
  const appDetail = page.locator("[data-app-detail]");
  assert.equal(await appDetail.locator("[data-version] > span").first().textContent(), "2.5.1+vim4.20261018.32");
  assert.equal(await appDetail.locator("[data-version]").getAttribute("title"), status.system.packages[0].version);
  assert.equal(await appDetail.getByText("开发版", { exact: true }).count(), 1);
  assert.equal(await appDetail.locator("[data-host]").textContent(), `${new URL(page.url()).hostname}:8080`);
  assert.equal(await appDetail.locator("a").count(), 0);
  assert.match(await charts.first().locator("[data-trend-detail]").textContent(), /· 最近 3 分钟 1% – 13%$/);
  assert.match(await charts.nth(4).locator("[data-trend-detail]").textContent(), /^最近 3 分钟 /);
  for (const chart of await charts.all()) assert.match(await chart.getByRole("img").getAttribute("aria-label"), /最近 3 分钟/);
  assert.equal(await page.locator("[data-chart=unsampled]").count(), 6);
  assert.equal(await page.getByText("尚未采样", { exact: true }).count(), 6);
  assert.deepEqual(await charts.locator("[data-trend-title]").allTextContents(), ["CPU", "内存", "网络", "CPU 动态功耗（估算）", "SoC 温度", "风扇"]);
  const hdmi = fact("HDMI 输入");
  assert.doesNotMatch(await hdmi.textContent(), /采集/);
  const uptime = fact("开机时长");
  for (const [label, href] of [["HDMI 输入", "#/video"], ["USB 键鼠", "#/services"], ["PD 协商", "#/services"]]) {
    assert.equal(await page.getByRole("link", { name: new RegExp(label) }).getAttribute("href"), href);
  }
  assert.equal(await uptime.evaluate((el) => el.matches("a") || !!el.querySelector("a")), false);
  assert.match(await uptime.locator("dd").last().textContent(), /^开机于 (\d+\/\d+ )?\d{2}:\d{2}$/);
  assert.doesNotMatch(await uptime.textContent(), /负载/);
  assert.equal(await charts.nth(2).locator("[data-trend-value] small").textContent(), "发送");
  assert.match(await charts.nth(2).locator("[data-legend]").textContent(), /接收 7 kbps/);
  await page.getByText("暂无事件", { exact: true }).waitFor();
  assert.ok((await page.getByRole("heading", { name: "最近事件", exact: true }).boundingBox()).y < 900);
  await hdmi.click();
  await page.waitForURL("**/#/video");
  await page.getByRole("heading", { name: "视频输入", exact: true }).first().waitFor();
  status.system.packages = [{ name: "vim4-manager", version: "1.0.0" }];
  await reload();
  assert.equal(await appDetail.textContent(), `${new URL(page.url()).hostname}:8080`);
  for (const [cpu, upper] of [[13, "25%"], [40, "50%"], [90, "100%"]]) {
    status.history = history(15, cpu);
    await reload();
    assert.equal(await charts.first().locator("[data-chart=tick]").nth(1).textContent(), upper);
    assert.equal(await page.locator("[data-chart=unsampled]").count(), 0);
    assert.equal(await page.getByText("尚未采样", { exact: true }).count(), 0);
    assert.equal(await page.getByText(/已采样/).count(), 0);
    assert.match(await charts.first().locator("[data-trend-detail]").textContent(), /· 15 分钟 /);
    assert.match(await charts.nth(4).locator("[data-trend-detail]").textContent(), /^15 分钟 /);
    for (const chart of await charts.all()) assert.match(await chart.getByRole("img").getAttribute("aria-label"), /最近 15 分钟/);
  }
  status.hardware.hdmi.captureWidth = 1920;
  status.hardware.hdmi.captureHeight = 1080;
  status.system.packages = [{ name: "vim4-onekvm", version: "2.5.1+vim4.20261018.32.dev.4.gabcdef0.dirty" }];
  status.events = Array.from({ length: 7 }, (_, i) => ({ t: now - i * 5000, tone: "good", text: `事件 ${i + 1}` }));
  await reload();
  assert.match(await hdmi.textContent(), /采集 1920×1080/);
  assert.equal(await page.locator("[data-event]").count(), 5);
  await page.getByRole("button", { name: "显示全部 7 条" }).click();
  assert.equal(await page.locator("[data-event]").count(), 7);

  // Keep pointer hover from competing with keyboard selection as charts scroll.
  await page.mouse.move(0, 0);
  for (const width of [1440, 1280, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
    for (const chart of await charts.all()) {
      await chart.getByRole("img").scrollIntoViewIfNeeded();
      await chart.getByRole("img").focus();
      await page.keyboard.press("ArrowLeft");
      const tooltip = chart.locator("[data-chart=tooltip]");
      await tooltip.waitFor({ state: "visible" });
      await page.waitForFunction((el) => {
        const b = el.getBoundingClientRect();
        return b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight
          && el.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2));
      }, await tooltip.elementHandle());
      await page.keyboard.press("ArrowRight");
      assert.equal(await page.locator("[data-chart=crosshair]").count(), 6, "crosshairs remain linked");
    }
  }
  console.log("PASS: overview history, axes, readouts, order, events, responsive layout and keyboard tooltips");
} finally {
  await browser.close();
}
