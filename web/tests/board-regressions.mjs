import assert from "node:assert/strict";
import { boardFixtures } from "./ui-fixtures.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const base = process.env.TEST_URL || "http://localhost:5188";
try {
  for (const locale of ["en", "zh-CN"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    await context.addInitScript(locale => localStorage.setItem("vim4-manager-language", locale), locale);
    let data = boardFixtures(locale);
    await context.route("**/api/**", route => route.fulfill({ json: data.status }));
    await context.route("**/__vim4/api/auth/state", route => route.fulfill({ json: data.auth }));
    const page = await context.newPage();
    await page.goto(base + "/#/overview");
    const regions = page.getByRole("region");
    const active = regions.filter({ has: page.locator("h2", { hasText: locale === "en" ? "Current KVM" : "当前 KVM" }) });
    const events = regions.filter({ has: page.locator("h2", { hasText: locale === "en" ? "Recent events" : "最近事件" }) });
    await page.locator("[data-pd-capabilities]").waitFor();
    const checkGap = async () => {
      const a = await active.boundingBox(), b = await events.boundingBox();
      assert(Math.abs(b.y - a.y - a.height - 16) < 1, "PD diagnostics must not increase the right-column gap");
    };
    await checkGap();
    await page.locator("[data-pd-capabilities] button").click();
    await checkGap();
    const boardBox = await page.locator("section").filter({ has: page.locator("[data-pd-capabilities]") }).boundingBox();
    const eventBox = await events.boundingBox();
    assert(Math.abs(boardBox.y + boardBox.height - eventBox.y - eventBox.height) < 1, "recent events fills the board height");
    const footer = events.locator("[data-slot=settings-row]").last();
    assert((await footer.boundingBox()).y > (await events.locator("[data-event]").boundingBox()).y + 60,
      "extra height belongs below events and above the footer");
    assert.equal(await page.locator("[data-chart=unsampled]").count(), 1);
    assert.equal(await page.locator("[data-trends]").getByText(locale === "en" ? "No samples yet" : "尚未采样", { exact: true }).count(), 0);
    assert((await page.locator("[data-chart=line]").getAttribute("d")).length > 0, "partial history still draws samples");
    const badgeStyle = async () => page.locator("[data-development-badge]").first().evaluate(el => {
      const s = getComputedStyle(el);
      return { font: s.fontFamily, size: s.fontSize, color: s.color, background: s.backgroundColor, border: s.borderTopWidth, radius: s.borderTopLeftRadius };
    });
    const overviewBadge = await badgeStyle();
    assert.match(overviewBadge.font, /system-ui/);
    assert.equal(overviewBadge.size, "12px");
    assert.equal(overviewBadge.border, "0px");
    await page.goto(base + "/#/apps");
    await page.locator("[data-development-badge]").waitFor();
    assert.deepEqual(await badgeStyle(), overviewBadge, "development badge must look identical inside a mono version row");
    await page.goto(base + "/#/overview");
    await page.setViewportSize({ width: 390, height: 844 });
    const wifi = page.locator("li").filter({ hasText: "wlan0" });
    await wifi.waitFor();
    assert.match(await wifi.textContent(), locale === "en" ? /wlan0, wlan1/ : /wlan0、wlan1/);
    const network = wifi.locator("..");
    const healthGrid = network.locator("..");
    assert((await network.boundingBox()).width > (await healthGrid.boundingBox()).width * 0.9,
      "mobile network block spans both health columns");
    const label = wifi.locator(":scope > span").first(), state = wifi.locator(":scope > span").last();
    const a = await label.boundingBox(), b = await state.boundingBox();
    assert(a.height < 24, "idle Wi-Fi names stay on one line");
    assert(Math.abs(a.y - b.y) < 5 || Math.abs(a.x - b.x) < 1, "wrapped status stays left aligned");
    data = boardFixtures(locale, "unknown");
    await page.reload();
    await page.locator("[data-trends]").getByRole("img").waitFor();
    assert.equal(await page.locator("section > dl > div").count(), 4);
    for (const tile of await page.locator("section > dl > div").all()) {
      const isUnknown = await tile.locator("dt").textContent();
      if (/HDMI/.test(isUnknown)) continue;
      const colors = await tile.evaluate(el => [
        getComputedStyle(el.querySelector("dt")).color,
        getComputedStyle(el.querySelector("dd span.min-w-0")).color,
      ]);
      assert.equal(colors[1], colors[0], "unknown values use the muted label color");
    }
    data = boardFixtures(locale, "empty");
    await page.reload();
    await page.locator("[data-chart=empty]").waitFor();
    assert.equal(await page.locator("[data-chart=line]").getAttribute("d"), "");
    assert.equal((await page.locator("[data-chart=empty]").textContent()).trim(), locale === "en" ? "No samples yet" : "尚未采样");
    await context.close();
  }
  console.log("PASS: real-board PD layout, partial/empty history, localized idle radios, shared development badges and unknown values");
} finally { await browser.close(); }
