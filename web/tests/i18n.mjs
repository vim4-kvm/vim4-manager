import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fixtures, localizeResponse } from "./ui-fixtures.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.TEST_URL || "http://127.0.0.1:5188";
const shots = "/tmp/i18n-codex/shots";
await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
let count = 0;
function pass(label) { console.log(`PASS ${++count}: ${label}`); }
async function session({ languages = ["en-US"], saved, login = false, width = 1440, theme = "light", disabledStorage = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: "reduce", colorScheme: theme });
  await context.addInitScript(({ languages, saved, disabledStorage }) => {
    Object.defineProperty(navigator, "languages", { get: () => languages });
    if (saved) localStorage.setItem("vim4-manager-language", saved);
    if (disabledStorage) Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Disabled", "SecurityError"); } });
  }, { languages, saved, disabledStorage });
  const data = fixtures();
  data.auth.authenticated = !login;
  // All API requests are intercepted; external requests are aborted.
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(base).origin) return route.abort();
    if (!url.pathname.includes("/api/")) return route.continue();
    const responses = { "/__vim4/api/auth/state": data.auth, "/api/status": data.status, "/api/passthrough": data.passthrough, "/api/account/sessions": data.account };
    if (url.pathname === "/__vim4/api/auth/login") return route.fulfill({ status: 401, json: { error: "Invalid credentials" } });
    return route.fulfill({ status: url.pathname in responses ? 200 : 404, json: localizeResponse(url.pathname, responses[url.pathname], route.request().headers().cookie) ?? { error: "Unexpected fixture API" } });
  });
  const page = await context.newPage();
  await page.goto(`${base}/${login ? "__vim4/login" : "#/overview"}`);
  await page.getByRole("button", { name: /Language/ }).waitFor();
  if (login) await page.locator("#username").waitFor();
  return { context, page };
}
async function expectLocale(page, locale) {
  await page.waitForFunction((locale) => document.documentElement.lang === locale, locale);
  assert.match(await page.evaluate(() => document.cookie), new RegExp(`vim4_lang=${locale}(;|$)`));
}
async function choose(page, language) {
  await page.getByRole("button", { name: /Language/ }).click();
  await page.getByRole("menuitemradio", { name: language, exact: true }).click();
  await page.getByRole("menu").waitFor({ state: "hidden" });
}
async function dismissMenu(page) {
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "hidden" });
}
async function screenshot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true, animations: "disabled" });
}
try {
  for (const [languages, saved, expected] of [
    [["fr-FR", "en-GB"], undefined, "en"], [["en-US", "zh-TW"], undefined, "zh-CN"],
    [[], undefined, "en"], [["zh-CN"], "en", "en"], [["en"], "zh-CN", "zh-CN"], [["en"], "invalid", "en"],
  ]) {
    const { context, page } = await session({ languages, saved });
    await expectLocale(page, expected);
    await context.close();
  }
  pass("navigator language resolution, saved preference, invalid preference, and fallback");
  const { context, page } = await session();
  const documentId = await page.evaluate(() => window.i18nDocumentId = crypto.randomUUID());
  const other = await context.newPage();
  await other.goto(`${base}/#/overview`);
  await choose(page, "简体中文");
  await expectLocale(page, "zh-CN");
  await expectLocale(other, "zh-CN");
  assert.equal(await page.evaluate(() => window.i18nDocumentId), documentId);
  assert.equal(await page.evaluate(() => localStorage.getItem("vim4-manager-language")), "zh-CN");
  await page.getByRole("navigation", { name: "页面", exact: true }).waitFor();
  pass("live header switch, html lang, cookie, persistence, and cross-tab sync without reload");
  await choose(other, "English");
  await expectLocale(page, "en");
  await page.getByRole("navigation", { name: "Pages", exact: true }).waitFor();
  await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === "/api/status"),
    page.reload(),
  ]);
  await expectLocale(page, "en");
  pass("reverse cross-tab sync and reload persistence");
  // Freeze the polling clock: only a locale-triggered read can satisfy this.
  await page.getByRole("button", { name: /Language/ }).click();
  await page.getByRole("menuitemradio", { name: "简体中文", exact: true }).waitFor();
  await page.clock.install({ time: new Date(0) });
  await page.clock.pauseAt(new Date(60000));
  const refreshed = page.waitForRequest(request => new URL(request.url()).pathname === "/api/status", { timeout: 1500 });
  await page.getByRole("menuitemradio", { name: "简体中文", exact: true }).press("Enter");
  // Allow React's effect frame, while staying well below the 3 s poll interval.
  await page.clock.runFor(100);
  const refreshRequest = await refreshed;
  assert.match(refreshRequest.headers().cookie ?? "", /vim4_lang=zh-CN/);
  await page.clock.resume();
  await page.getByRole("menu").waitFor({ state: "hidden" });
  pass("locale changes immediately refetch server text with the new cookie while the polling clock is paused");
  for (const locale of ["en", "zh-CN"]) {
    await choose(page, locale === "en" ? "English" : "简体中文");
    await page.getByRole("button", { name: /Language/ }).click();
    await screenshot(page, `header-${locale}-desktop-light-menu`);
    await dismissMenu(page);
  }
  await page.evaluate(() => { location.hash = "#/apps"; });
  const description = locale => fixtures(locale).status.apps.find(app => app.id === "onekvm").description;
  await page.getByText(description("zh-CN"), { exact: true }).waitFor();
  await choose(page, "English");
  await page.getByText(description("en"), { exact: true }).waitFor();
  pass("server-owned app descriptions follow the request cookie and match the Go catalogs after live switching");
  await context.close();
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    const { context, page } = await session({ login: true, width, theme });
    await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    const identity = await page.evaluate(() => window.i18nDocumentId = crypto.randomUUID());
    for (const locale of ["en", "zh-CN"]) {
      await choose(page, locale === "en" ? "English" : "简体中文");
      await expectLocale(page, locale);
      assert.equal(await page.title(), locale === "en" ? "Sign in · VIM4 KVM" : "登录 · VIM4 KVM");
      await page.getByLabel(locale === "en" ? "Password" : "密码", { exact: true }).waitFor();
      const viewport = width === 390 ? "mobile" : "desktop";
      await screenshot(page, `login-${locale}-${viewport}-${theme}`);
      await page.getByRole("button", { name: /Language/ }).click();
      await screenshot(page, `login-${locale}-${viewport}-${theme}-menu`);
      await dismissMenu(page);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    assert.equal(await page.evaluate(() => window.i18nDocumentId), identity);
    await page.getByLabel("密码", { exact: true }).fill("incorrect password");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByText("用户名或密码错误", { exact: true }).waitFor();
    await screenshot(page, `login-zh-CN-${width === 390 ? "mobile" : "desktop"}-${theme}-error`);
    await choose(page, "English");
    await page.getByText("Couldn't sign in. Check your username and password.", { exact: true }).waitFor();
    await page.getByLabel("Password", { exact: true }).fill("incorrect password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByText("Couldn't sign in. Check your username and password.", { exact: true }).waitFor();
    await screenshot(page, `login-en-${width === 390 ? "mobile" : "desktop"}-${theme}-error`);
    await context.close();
  }
  pass("login switcher, labels, title, both locales, error responses, desktop/mobile and light/dark screenshots");
  const restricted = await session({ login: true, disabledStorage: true });
  await choose(restricted.page, "简体中文");
  await expectLocale(restricted.page, "zh-CN");
  await restricted.context.close();
  pass("switching remains usable when localStorage is disabled");
  const delayed = await session();
  let releaseCatalog;
  const catalogGate = new Promise(resolve => { releaseCatalog = resolve; });
  await delayed.context.route(/\/(?:src\/i18n\/zh-CN\.ts|__vim4\/assets\/zh-CN-[^/]+\.js)(?:\?.*)?$/, async route => {
    await catalogGate;
    await route.continue();
  });
  await choose(delayed.page, "简体中文");
  await delayed.page.waitForFunction(() => document.querySelector('header button[aria-label="Language"] svg')?.getAttribute("class")?.includes("animate-spin"));
  await expectLocale(delayed.page, "en");
  await delayed.page.getByRole("navigation", { name: "Pages", exact: true }).waitFor();
  releaseCatalog();
  await expectLocale(delayed.page, "zh-CN");
  await delayed.page.getByRole("navigation", { name: "页面", exact: true }).waitFor();
  await delayed.context.close();
  for (const login of [false, true]) {
    const initial = await session({ saved: "zh-CN", login });
    await expectLocale(initial.page, "zh-CN");
    await initial.page.getByRole("button", { name: login ? "登录" : "刷新设备状态", exact: true }).waitFor();
    await initial.context.close();
  }
  pass("lazy Chinese catalog keeps English visible until ready, shows delayed loading, and initializes both entries in Chinese");
} finally { await browser.close(); }
console.log(`${count} localization checks passed`);
