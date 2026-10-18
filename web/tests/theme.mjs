import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const url = `${process.env.TEST_URL || "http://127.0.0.1:5188"}/#/overview`;
const key = "vim4-manager-theme";
const status = {
  active: "", apps: [], platform: [],
  hardware: { hostname: "vim4", kernel: "5.15.137", uptimeSeconds: 60, load1: 0, cpus: 8,
    memTotalKiB: 1024, memAvailableKiB: 512, tempC: 50, zones: [], fanAuto: true,
    fanPercent: 30, usb: "configured", hdmi: { signal: false, audio: false }, hdrCurve: { white: 203, peak: 1000 } },
  system: { links: [], disk: { totalBytes: 1, freeBytes: 1 }, packages: [] }, events: [], history: [],
};
const browser = await chromium.launch({ channel: "chrome", headless: true });
async function expectTheme(page, theme) {
  await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
  assert.equal(await page.locator("html").evaluate((el) => el.style.colorScheme), theme);
}
async function context(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", ...options });
  await context.route("**/api/**", (route) => route.fulfill({ status: 404, json: { error: "Unexpected test API" } }));
  await context.route("**/api/status", (route) => route.fulfill({ json: status }));
  return context;
}
try {
  const session = await context();
  const page = await session.newPage();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(url);
  await expectTheme(page, "dark");
  const appearance = page.getByRole("radiogroup", { name: "外观" });
  assert.equal(await appearance.count(), 1, "only the desktop control is accessible");
  await page.emulateMedia({ colorScheme: "light" });
  await expectTheme(page, "light");
  await appearance.getByRole("radio", { name: "深色", exact: true }).click();
  await expectTheme(page, "dark");
  await page.reload();
  await expectTheme(page, "dark");
  assert.equal(await appearance.getByRole("radio", { name: "深色" }).getAttribute("aria-checked"), "true");
  await appearance.getByRole("radio", { name: "系统", exact: true }).click();
  await expectTheme(page, "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectTheme(page, "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expectTheme(page, "light");

  // Roving tab stops, immediate selection, and wrapping at both ends.
  await appearance.getByRole("radio", { name: "系统", exact: true }).focus();
  for (const [arrow, name, theme] of [["ArrowLeft", "深色", "dark"], ["ArrowRight", "系统", "light"],
    ["ArrowRight", "浅色", "light"], ["ArrowLeft", "系统", "light"]]) {
    await page.keyboard.press(arrow);
    await expectTheme(page, theme);
    assert.equal(await appearance.getByRole("radio", { name, exact: true }).evaluate((el) =>
      el === document.activeElement && el.tabIndex === 0 && el.getAttribute("aria-checked") === "true"), true);
    assert.equal(await appearance.locator('[tabindex="0"]').count(), 1);
  }

  const other = await session.newPage();
  await other.goto(url);
  await appearance.getByRole("radio", { name: "深色", exact: true }).click();
  await expectTheme(other, "dark");
  await other.getByRole("radio", { name: "浅色", exact: true }).click();
  await expectTheme(page, "light");
  await other.evaluate((key) => localStorage.removeItem(key), key);
  await appearance.getByRole("radio", { name: "系统", exact: true, checked: true }).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
  assert.equal(await appearance.count(), 1, "only the mobile control is accessible");
  assert.equal(await appearance.locator("svg").count(), 3);
  assert.equal(await appearance.locator("button span").count(), 0, "mobile control uses icons");
  await appearance.getByRole("radio", { name: "跟随系统", exact: true }).click();
  await appearance.getByRole("radio", { name: "深色", exact: true }).click();
  await expectTheme(page, "dark");
  await page.waitForFunction(() => !document.documentElement.classList.contains("theme-switching"));
  await session.close();

  // Capture at DOMContentLoaded, before waiting for React or a later animation frame.
  for (const [stored, scheme, expected] of [["dark", "light", "dark"], ["light", "dark", "light"],
    ["system", "dark", "dark"], ["invalid", "light", "light"]]) {
    const firstFrame = await context({ colorScheme: scheme });
    await firstFrame.addInitScript(({ key, stored }) => {
      localStorage.setItem(key, stored);
      document.addEventListener("DOMContentLoaded", () => {
        window.initialTheme = [document.documentElement.dataset.theme, document.documentElement.style.colorScheme];
      }, { once: true });
    }, { key, stored });
    const first = await firstFrame.newPage();
    await first.goto(url, { waitUntil: "domcontentloaded" });
    assert.deepEqual(await first.evaluate(() => window.initialTheme), [expected, expected]);
    await expectTheme(first, expected);
    await firstFrame.close();
  }

  for (const blocked of ["read", "write"]) {
    const restricted = await context({ colorScheme: "light" });
    await restricted.addInitScript(({ key, blocked }) => {
      if (blocked === "write") localStorage.setItem(key, "dark");
      Object.defineProperty(Storage.prototype, blocked === "read" ? "getItem" : "setItem", {
        value() { throw new DOMException("Storage disabled", "SecurityError"); },
      });
    }, { key, blocked });
    const restrictedPage = await restricted.newPage();
    const errors = [];
    restrictedPage.on("pageerror", (error) => errors.push(error.message));
    await restrictedPage.goto(url);
    await restrictedPage.getByRole("radio", { name: "深色", exact: true }).click();
    await expectTheme(restrictedPage, "light");
    await restrictedPage.emulateMedia({ colorScheme: "dark" });
    await expectTheme(restrictedPage, "dark");
    assert.deepEqual(errors, []);
    await restricted.close();
  }
  console.log("PASS: system theme, persisted choice, live media changes, keyboard, cross-tab sync, first frame, storage failures and mobile control");
} finally {
  await browser.close();
}
