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
  assert.equal(await page.locator("html").evaluate((el) => getComputedStyle(el).colorScheme), theme);
  assert.equal(await page.locator("html").evaluate((el) => el.classList.contains("dark")), theme === "dark", "Tailwind dark class follows the theme");
}
const accountButton = (page) => page.getByRole("button", { name: "Account menu", exact: true });
const appearance = (page) => page.getByRole("menu", { name: "Account menu" }).getByRole("group", { name: "Appearance" });
// Choosing keeps the account menu open; Escape returns focus to the avatar.
async function choose(page,name) {
 await page.getByRole("menu", {name:"Account menu"}).waitFor({state:"hidden"});
 await accountButton(page).click();
 const item = appearance(page).getByRole("menuitemradio",{name,exact:true});
 await item.focus();
 await page.keyboard.press("Enter");
 await page.keyboard.press("Escape");
 await menuClosed(page);
}
async function menuClosed(page) {
  await page.getByRole("menu", { name: "Account menu" }).waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Account menu");
}
async function context(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", ...options });
  await context.route("**/api/**", (route) => route.fulfill({ status: 404, json: { error: "Unexpected test API" } }));
  await context.route("**/api/status", (route) => route.fulfill({ json: status }));
  await (await import("./auth-fixture.mjs")).authenticated(context);
  return context;
}
try {
  const session = await context();
  const page = await session.newPage();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(url);
  await expectTheme(page, "dark");
  assert.equal(await page.locator("header button").count(), 2, "the top bar holds only the sidebar toggle and the avatar");
  await page.emulateMedia({ colorScheme: "light" });
  await expectTheme(page, "light");
  await choose(page, "Dark");
  await expectTheme(page, "dark");
  await page.reload();
  await expectTheme(page, "dark");
  await accountButton(page).click();
  assert.equal(await appearance(page).getByRole("menuitemradio", { name: "Dark" }).getAttribute("aria-checked"), "true");
  await page.keyboard.press("Escape");
  await menuClosed(page);
  await choose(page, "System");
  await expectTheme(page, "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectTheme(page, "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expectTheme(page, "light");

  // Arrow keys walk the appearance and language segments, then the account items, and wrap.
  await accountButton(page).focus();
  await page.keyboard.press('Enter');
  const waitFocus = async name => { await page.waitForFunction(name => (document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent.trim()) === name, name); };
  await waitFocus('Light');
  for (const name of ['Dark', 'System', 'English', '中文', 'Account and signed-in devices', 'Sign out', 'Light']) {
    await page.keyboard.press('ArrowDown'); await waitFocus(name);
  }
  await page.keyboard.press('ArrowUp'); await waitFocus('Sign out');
  await page.keyboard.press('Home'); await waitFocus('Light');
  await page.keyboard.press('ArrowDown'); await waitFocus('Dark');
  await page.keyboard.press('ArrowDown'); await waitFocus('System');
  await page.keyboard.press('Enter');
  await appearance(page).getByRole("menuitemradio",{name:"System",exact:true,checked:true}).waitFor();
  await waitFocus('System');
  await page.keyboard.press('Tab');
  await page.getByRole("menu", { name: "Account menu" }).waitFor({ state: "hidden" });
  const other = await session.newPage();
  await other.goto(url);
  await choose(page, "Dark");
  await expectTheme(other, "dark");
  await choose(other,"Light");
  await expectTheme(page, "light");
  await other.evaluate((key) => localStorage.removeItem(key), key);
  await accountButton(page).click();
  await appearance(page).getByRole("menuitemradio",{name:"System",exact:true,checked:true}).waitFor();
  await page.keyboard.press("Escape");
  await menuClosed(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open menu", exact: true }).waitFor();
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
  assert.equal(await accountButton(page).count(),1,"mobile shares the avatar menu");
  await accountButton(page).click();
  await appearance(page).waitFor({ state: "visible" });
  assert.equal(await page.getByRole("group", { name: "Appearance" }).count(), 1, "only the account menu offers appearance");
  assert.equal(await appearance(page).getByRole("menuitemradio").count(), 3);
  assert(await page.getByRole("menu").evaluate(menu => { const box = menu.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; }), "menu stays inside the phone viewport");
  await page.keyboard.press("Escape");
  await menuClosed(page);
  await choose(page, "System");
  await choose(page, "Dark");
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
        window.initialTheme = [document.documentElement.dataset.theme, getComputedStyle(document.documentElement).colorScheme,
          document.documentElement.classList.contains("dark") ? "dark" : "light"];
      }, { once: true });
    }, { key, stored });
    const first = await firstFrame.newPage();
    await first.goto(url, { waitUntil: "domcontentloaded" });
    assert.deepEqual(await first.evaluate(() => window.initialTheme), [expected, expected, expected]);
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
    await choose(restrictedPage,"Dark");
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
