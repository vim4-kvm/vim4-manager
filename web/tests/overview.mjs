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
  await (await import("./auth-fixture.mjs")).pinLanguage(page);
  await page.route("**/api/**", (route) => route.fulfill({ status: 404, json: {} }));
  await page.route("**/api/status", (route) => route.fulfill({ json: status }));
  await (await import("./auth-fixture.mjs")).authenticated(page);
  const charts = page.locator("[data-trends] figure");
  const fact = (label) => page.locator("div:has(> dt)").filter({ has: page.locator("dt", { hasText: new RegExp(`${label}$`) }) });
  const reload = async () => {
    await page.goto(`${process.env.TEST_URL || "http://127.0.0.1:5188"}/#/overview`);
    await page.reload();
    await charts.locator("svg").last().waitFor();
  };
  await reload();
  const board = page.getByRole("region", { name: "Device connections", exact: true });
  const desktopDiagram = board.locator(".device-connections-compact").filter({ visible: true });
  assert((await desktopDiagram.getByRole("img").boundingBox()).width > 200, "compact board image is visible");
  assert.equal(await desktopDiagram.locator(".connection-endpoint, .connection-lines").count(), 0);
  await desktopDiagram.getByRole("button", { name: "HDMI IN port", exact: true }).focus();
  await page.keyboard.press("Enter");
  await desktopDiagram.getByRole("region").waitFor();
  await desktopDiagram.getByRole("button", { name: "Close port details" }).click();
  assert.equal(await board.locator("dl > div").count(), 4);
  await page.setViewportSize({ width: 390, height: 900 });
  const show = board.getByRole("button", { name: "Show connections" });
  assert.equal(await show.getAttribute("aria-expanded"), "false");
  await show.click();
  await board.locator(".device-connections-compact").filter({ visible: true }).getByRole("img").waitFor();
  await board.getByRole("button", { name: "Hide connections" }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByText(/3 minutes sampled/).waitFor();
  const appDetail = page.locator("[data-app-detail]");
  assert.equal(await appDetail.locator("[data-version] > span").first().textContent(), "2.5.1+vim4.20261018.32");
  assert.equal(await appDetail.locator("[data-version]").getAttribute("title"), status.system.packages[0].version);
  assert.equal(await appDetail.getByText("Development build", { exact: true }).count(), 1);
  assert.equal(await appDetail.locator("[data-host]").textContent(), `${new URL(page.url()).hostname}:8080`);
  assert.equal(await appDetail.locator("a").count(), 0);
  const metricNames = ['CPU','Memory','Network','Power','Temperature','Fan'];
  const metricTitles = [];
  for (const name of metricNames) {
    await page.getByRole('tab',{name,exact:true}).click();
    metricTitles.push(await charts.locator('[data-trend-title]').textContent());
    assert.match(await charts.getByRole('img').getAttribute('aria-label'), /last 3 minutes/);
    assert.equal(await page.locator('[data-chart=unsampled]').count(),1);
    assert.equal(await page.getByText('No samples yet',{exact:true}).count(),0);
  }
  assert.deepEqual(metricTitles,['CPU usage','Memory usage','Network upload','CPU dynamic power (estimated)','SoC temperature','Fan duty']);
  await page.getByRole('tab',{name:'CPU',exact:true}).click();
  assert.equal(await charts.getByText('1%',{exact:true}).count(),1,'minimum readout');
  assert.equal(await charts.getByText('13%',{exact:true}).count(),2,'current and peak readouts');
  const hdmi = fact("HDMI input");
  assert.doesNotMatch(await hdmi.textContent(), /Capture/);
  const uptime = page.getByText(/^Uptime/);
  for (const [label, href] of [["HDMI input", "#/video"], ["USB input", "#/services"], ["USB-C power", "#/services"]]) {
    assert.equal(await page.getByRole("link", { name: new RegExp(label) }).getAttribute("href"), href);
  }
  assert.equal(await uptime.evaluate((el) => el.matches("a") || !!el.querySelector("a")), false);
  assert.match(await uptime.getAttribute("title"), /^Started .*\d{2}:\d{2}/);
  assert.doesNotMatch(await uptime.textContent(), /Load/);
  await page.getByRole("tab",{name:"Network",exact:true}).click();
  assert.equal(await charts.locator("[data-trend-title]").textContent(),"Network upload");
  assert.match(await charts.locator("figcaption").textContent(), /Download 7 kbps/);
  await page.getByText("No events yet", { exact: true }).waitFor();
  assert.ok((await page.getByRole("heading", { name: "Recent events", exact: true }).boundingBox()).y < 900);
  await hdmi.click();
  await page.waitForURL("**/#/video");
  await page.getByRole("heading", { name: "Video input", exact: true }).first().waitFor();
  status.system.packages = [{ name: "vim4-manager", version: "1.0.0" }];
  await reload();
  assert.equal(await appDetail.textContent(), `${new URL(page.url()).hostname}:8080`);
  for (const [cpu, upper] of [[13, "15%"], [23, "30%"], [40, "40%"], [90, "100%"]]) {
    status.history = history(15, cpu);
    await reload();
    const upperValue = Number.parseFloat(upper);
    assert(cpu / upperValue >= 0.6, "peak occupies at least 60% of the plot");
    assert.equal(await charts.first().locator('[data-chart=tick][text-anchor="end"][dominant-baseline="middle"]').last().textContent(), upper);
    assert.equal(await page.locator("[data-chart=unsampled]").count(), 0);
    assert.equal(await page.getByText("No samples yet", { exact: true }).count(), 0);
    assert.equal(await page.getByText(/已采样/).count(), 0);
    assert.match(await charts.getByRole("img").getAttribute("aria-label"), /last 15 minutes/);
    for (const chart of await charts.all()) assert.match(await chart.getByRole("img").getAttribute("aria-label"), /last 15 minutes/);
  }
  status.hardware.hdmi.captureWidth = 1920;
  status.hardware.hdmi.captureHeight = 1080;
  status.system.packages = [{ name: "vim4-onekvm", version: "2.5.1+vim4.20261018.32.dev.4.gabcdef0.dirty" }];
  status.events = Array.from({ length: 7 }, (_, i) => ({ t: now - i * 5000, tone: "good", text: `Event ${i + 1}` }));
  await reload();
  assert.match(await hdmi.textContent(), /Capture 1920×1080/);
  assert.equal(await page.locator("[data-event]").count(), 3);
  await page.getByRole("button", { name: "Show all 7 events" }).click();
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
      assert.equal(await page.locator("[data-chart=crosshair]").count(), 1, "the active chart retains its crosshair");
    }
  }
  for (const locale of ["en", "zh-CN"]) {
    await page.evaluate(locale => {
      localStorage.setItem("vim4-manager-language", locale);
      window.dispatchEvent(new StorageEvent("storage", { key: "vim4-manager-language", newValue: locale }));
    }, locale);
    await page.waitForFunction(locale => document.documentElement.lang === locale, locale);
    const list = page.getByRole("tablist");
    const rows = await list.getByRole("tab").evaluateAll(tabs => tabs.map(tab => tab.getBoundingClientRect().top));
    assert(rows.every(y => Math.abs(y - rows[0]) < 1), "resource tabs stay on one row");
    await list.getByRole("tab").last().evaluate(tab => tab.click());
    await page.waitForFunction(() => {
      const tab = document.querySelector('[role=tab][data-state=active]');
      const list = tab?.closest('[role=tablist]');
      if (!tab || !list) return false;
      const a = tab.getBoundingClientRect(), b = list.getBoundingClientRect();
      return a.left >= b.left - 1 && a.right <= b.right + 1;
    });
  }
  console.log("PASS: overview history, axes, readouts, order, events, responsive layout, keyboard tooltips and scrolling tabs in both locales");
} finally {
  await browser.close();
}
