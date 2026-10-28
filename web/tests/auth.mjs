import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.TEST_URL || "http://127.0.0.1:5188";
const accountShots = `${process.env.SCREENSHOTS || "/tmp/codex-ui"}/auth-account`;
await mkdir(accountShots, { recursive: true });
const shots = `${process.env.SCREENSHOTS || "/tmp/codex-ui"}/auth-login`;
await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
let count = 0;
function pass(name) { console.log(`PASS ${++count}: ${name}`); }

async function stableScreenshot(page, name, fullPage = true, directory = shots) {
  // Motion drives page fades with script-created Web Animations whose timeline
  // stalls under page.clock; finish them so only CSS animations are awaited.
  await page.evaluate(() => document.getAnimations().forEach(animation => {
    if (!(animation instanceof CSSAnimation || animation instanceof CSSTransition)) animation.finish();
  }));
  await page.waitForFunction(() => {
    const themeSettled = !document.documentElement.classList.contains("theme-switching");
    const animationsSettled = document.getAnimations().every(animation =>
      animation.playState !== "running" || animation.effect.getTiming().iterations === Infinity);
    return themeSettled && animationsSettled;
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.screenshot({ path: `${directory}/${name}.png`, fullPage });
}

// Radix restores focus to the menu trigger after its close animation frame.
async function focused(locator) {
  await locator.evaluate(el => new Promise((resolve, reject) => {
    const start = performance.now();
    const check = () => el === document.activeElement ? resolve() : performance.now() - start > 2000 ? reject(new Error("focus not restored: " + JSON.stringify({ connected: el.isConnected, expected: el.getAttribute("aria-label"), active: document.activeElement?.tagName, activeId: document.activeElement?.id, activeLabel: document.activeElement?.getAttribute("aria-label"), dialogs: document.querySelectorAll("[role=dialog]").length }))) : requestAnimationFrame(check);
    check();
  }));
}

async function checkAccountContrast(page) {
  const contrasts = await page.evaluate(() => {
    function luminance(color) {
      const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
        value /= 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    }
    return [['[data-account-devices] h3', '[data-account-devices]'], ['[data-account-devices] p', '[data-account-devices]'], ["[data-brand]", "[data-slot=sidebar-inner]"]].map(([text, background]) => {
      const foreground = luminance(getComputedStyle(document.querySelector(text)).color);
      const surface = luminance(getComputedStyle(document.querySelector(background)).backgroundColor);
      return (Math.max(foreground, surface) + 0.05) / (Math.min(foreground, surface) + 0.05);
    });
  });
  assert(contrasts.every(value => value >= 4.5), `account and brand contrast: ${contrasts}`);
}

async function checkCompactHeader(page, width) {
  await page.setViewportSize({ width, height: 844 });
  // Phone top bar: menu button, page title, account button.
  const menu = await page.getByRole("button", { name: "打开菜单", exact: true }).boundingBox();
  const account = await page.getByRole("button", { name: "账户菜单", exact: true }).boundingBox();
  assert(menu && account);
  assert(menu.x + menu.width <= account.x, "menu button precedes the account button");
  assert(Math.abs(menu.y + menu.height / 2 - account.y - account.height / 2) <= 1, "top bar controls vertically align");
  assert.equal(await page.getByRole("radiogroup", { name: "外观" }).count(), 0, "sidebar controls stay in the closed sheet");
  assert(await page.getByRole("button", { name: "退出登录", exact: true }).isVisible());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}

async function checkLoginContrast(page) {
  const values = await page.evaluate(() => {
    function rgba(value) {
      return value.match(/[\d.]+/g).map(Number);
    }
    function blend(top, bottom) {
      const alpha = top[3] ?? 1;
      return top.slice(0, 3).map((value, index) => value * alpha + bottom[index] * (1 - alpha));
    }
    function background(element) {
      if (!element) return [255, 255, 255];
      return blend(rgba(getComputedStyle(element).backgroundColor), background(element.parentElement));
    }
    function luminance(channels) {
      const linear = channels.slice(0, 3).map(value => {
        value /= 255;
        return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
      });
      return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
    }
    return ["[role=menu] [data-slot=dropdown-menu-label] strong", "[role=menu] [data-slot=dropdown-menu-label] small", "[role=menu] [role=menuitem]", "[data-account-success]", "[role=row] [data-slot=badge]", "[data-account-notes]", "main h1", "main label", "main input", "main button[data-variant=default]", "main [role=alert]", "main code", "main [aria-invalid=true]"].flatMap(selector =>
      [...document.querySelectorAll(selector)].map(element => {
        const foreground = luminance(rgba(getComputedStyle(element).color));
        const surface = luminance(background(element));
        return { selector, ratio: (Math.max(foreground, surface) + .05) / (Math.min(foreground, surface) + .05),
          // Filled primary buttons use --primary-fill and must meet 4.5:1 in both themes.
          minimum: selector === "[role=menu] [data-slot=dropdown-menu-label] small" || element.closest("[data-account-notes]") ? 3 : 4.5 };
      }));
  });
  for (const value of values) assert(value.ratio >= value.minimum, JSON.stringify(value));
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce" });
  let state = { configured: true, authenticated: false, username: "admin", secure: false, setupAllowed: true, retryAfter: 0, hostname: "Khadas" };
  let stateFails = false;
  let releaseState;
  let stateRequested;
  let holdState = false;
  let loginRequests = 0;
  let retryAfter = 2;
  let loginStatus = 401;
  let sessionsFail = false;
  let sessionsWait;
  let revokeFail = false;
  let logoutFail = false;
  let account = { username: "admin", passwordChanged: "2026-10-18T12:00:00Z", sessions: [
    { id: "current", current: true, address: "192.168.1.2", userAgent: "Mozilla Macintosh Chrome/120", lastActive: new Date().toISOString() },
    { id: "other", current: false, address: "127.0.0.1", userAgent: "Mozilla iPhone Safari/17", lastActive: new Date(Date.now() - 7200000).toISOString() },
  ] };
  const otherDevice = { ...account.sessions[1] };
  const writes = [];
  await page.route("**/api/**", route => route.fulfill({ status: 404, json: {} }));
  await page.route("**/api/status", route => route.fulfill({ json: {
    active: "", apps: [], platform: [],
    hardware: { hostname: "Khadas", kernel: "5.15.137-vim4kvm", uptimeSeconds: 60, load1: 0, cpus: 8,
      memTotalKiB: 1024, memAvailableKiB: 512, tempC: 50, zones: [], fanAuto: true,
      fanPercent: 30, usb: "configured", hdmi: { signal: false, audio: false }, hdrCurve: { white: 203, peak: 1000 } },
    system: { links: [], disk: { totalBytes: 1, freeBytes: 1 }, packages: [] }, events: [], history: [],
  } }));
  await page.route("**/__vim4/api/auth/state", async route => {
    if (holdState) await new Promise(resolve => {
      releaseState = resolve;
      stateRequested();
    });
    return stateFails ? route.abort() : route.fulfill({ json: state });
  });
  await page.route("**/__vim4/api/auth/login", route => {
    loginRequests++;
    if (loginStatus === 0) return route.abort();
    if (loginStatus === 200) state.authenticated = true;
    return route.fulfill({ status: loginStatus, json: { error: "用户名或密码错误", retryAfter } });
  });
  let setupStatus = 200;
  await page.route("**/__vim4/api/auth/setup", route => {
    if (setupStatus === 200) state = { ...state, configured: true, authenticated: true };
    return route.fulfill({ status: setupStatus, json: { ok: true } });
  });
  await page.route("**/__vim4/api/auth/logout", route => { if (logoutFail) return route.fulfill({ status: 500, json: {} }); state.authenticated = false; return route.fulfill({ json: { ok: true } }); });
  await page.route("**/api/account/**", async route => {
    if (route.request().method() === "GET") {
      if (sessionsWait) await sessionsWait;
      return route.fulfill({ status: sessionsFail ? 500 : 200, json: account });
    }
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("password") && route.request().postDataJSON().currentPassword === "wrong") return route.fulfill({ status: 403, json: { error: "当前密码错误" } });
    if (path.endsWith("revoke") && revokeFail) return route.fulfill({ status: 500, json: { error: "退出设备失败" } });
    writes.push({ path, body: route.request().postDataJSON() });
    if (path.endsWith("password") || path.endsWith("username") || path.endsWith("logout-others")) account.sessions = account.sessions.filter(d => d.current);
    if (path.endsWith("username")) account.username = route.request().postDataJSON().username;
    if (path.endsWith("revoke")) account.sessions = account.sessions.filter(d => d.id !== route.request().postDataJSON().id);
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(`${base}/#/account`);
  await page.waitForURL(/\/__vim4\/login\?next=/);
  assert.equal(new URL(page.url()).searchParams.get("next"), "/#/account");
  await page.getByRole("heading", { name: "Khadas", exact: true }).waitFor();
  pass("unauthenticated startup redirects with hash route");
  const password = page.getByLabel("密码", { exact: true });
  const username = page.getByLabel("用户名", { exact: true });
  const login = page.getByRole("button", { name: "登录", exact: true });
  await page.getByRole("radio", { name: "浅色", exact: true }).click();
  await stableScreenshot(page, "desktop-light");
  const card = await page.getByRole("region", { name: "设备登录" }).boundingBox();
  const identity = page.getByRole("group", { name: "设备" });
  const identityBox = await identity.boundingBox();
  assert.equal(identityBox.y, 180, "desktop identity starts at 20vh");
  assert.equal(card.width, 400);
  assert.equal(card.x + card.width / 2, 720, "login centers across the full viewport");
  for (const [width, height, top] of [[480, 200, 48], [479, 900, 108]]) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction((top) => Math.round(document.querySelector('[aria-label="设备"]').getBoundingClientRect().top + scrollY) === top, top);
    assert.equal(await identity.evaluate(element => element.getBoundingClientRect().top + scrollY), top,
      "desktop keeps a 48px minimum; narrow screens keep 12vh");
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await page.title(), "登录 · Khadas — VIM4 KVM");
  assert(await login.isEnabled(), "empty password does not disable submit");
  await username.fill("");
  await login.click();
  assert.equal(loginRequests, 0);
  await page.getByText("请输入用户名", { exact: true }).waitFor();
  await page.getByText("请输入密码", { exact: true }).waitFor();
  assert.deepEqual(await identity.boundingBox(), identityBox, "field errors keep the identity anchored");
  assert.equal(await username.getAttribute("aria-invalid"), "true");
  assert(await username.evaluate(element => element === document.activeElement));
  await username.fill("admin");
  assert.equal(await page.getByText("请输入用户名", { exact: true }).count(), 0);
  await password.fill("password1");
  assert.equal(await page.getByText("请输入密码", { exact: true }).count(), 0);
  await password.fill("");
  await username.focus();
  for (const target of [password, page.getByRole("button", { name: "显示密码" }), login, page.getByRole("button", { name: "忘记密码？" }), page.getByRole("radio", { checked: true })]) {
    await page.keyboard.press("Tab");
    assert(await target.evaluate(element => element === document.activeElement));
  }
  await password.focus();
  await password.dispatchEvent("keydown", { key: "A", modifierCapsLock: true });
  await page.getByText("⇪ 大写锁定已开启").waitFor();
  await password.blur();
  assert.equal(await page.getByText("⇪ 大写锁定已开启").count(), 0);
  await page.getByRole("radio", { name: "深色", exact: true }).click();
  await stableScreenshot(page, "desktop-dark");
  await checkLoginContrast(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await stableScreenshot(page, "phone-dark");
  await checkLoginContrast(page);
  await page.getByRole("radio", { name: "浅色", exact: true }).click();
  await stableScreenshot(page, "phone-light");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 390, height: 500 });
  await login.scrollIntoViewIfNeeded();
  const loginBox = await login.boundingBox();
  assert(loginBox.y >= 0 && loginBox.y + loginBox.height <= 500);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "忘记密码？" }).click();
  assert.deepEqual(await identity.boundingBox(), identityBox, "password recovery grows down from the identity");
  await stableScreenshot(page, "forgot-open");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "复制", exact: true }).click();
  await page.getByRole("button", { name: "已复制", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "sudo vim4-manager set-password");
  await page.getByRole("button", { name: "复制", exact: true }).waitFor();
  await page.getByRole("button", { name: "忘记密码？" }).click();
  assert.equal(await page.locator("#password-recovery").count(), 0);
  pass("empty submit, field recovery, tab order, caps lock, themes, short viewport and reset copy");

  stateFails = true;
  await page.reload();
  await page.getByRole("alert").getByText("无法连接板子，请检查网络后重试").waitFor();
  assert.equal(await page.locator("form").count(), 0);
  stateFails = false;
  holdState = true;
  const pendingState = new Promise(resolve => { stateRequested = resolve; });
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.getByRole("status", { name: "正在连接" }).waitFor();
  assert.equal(await page.locator("form").count(), 0);
  assert.equal(await page.locator("[data-slot=skeleton]").count(), 4);
  await pendingState;
  holdState = false;
  releaseState();
  await password.waitFor();
  pass("failed state load retries through a static skeleton");
  let releaseLogin;
  const pendingLogin = new Promise(resolve => { releaseLogin = resolve; });
  await page.route("**/__vim4/api/auth/login", async route => {
    await pendingLogin;
    await route.fulfill({ status: 503, json: {} });
  }, { times: 1 });
  await password.fill("password1");
  await password.press("Enter");
  const submitting = page.getByRole("button", { name: "正在登录…" });
  await submitting.waitFor();
  assert(await submitting.isDisabled());
  assert.equal(await submitting.getAttribute("aria-busy"), "true");
  assert.equal(await password.getAttribute("readonly"), "");
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.getByRole("button", { name: "正在登录…" }).locator("[aria-hidden=true]").evaluate(element => getComputedStyle(element).animationName), "none");
  releaseLogin();
  await page.getByRole("alert").waitFor();
  assert.equal(await page.getByRole("alert").evaluate(element => getComputedStyle(element).animationName), "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  pass("Enter submits, pending request locks the form and reduced motion removes animations");
  await password.fill("wrong-password");
  await page.getByRole("button", { name: "显示密码" }).click();
  assert.equal(await password.getAttribute("type"), "text");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByText("用户名或密码错误", { exact: true }).waitFor();
  assert.deepEqual(await identity.boundingBox(), identityBox, "server errors keep the identity anchored");
  assert.equal(await page.getByRole("alert").count(), 1);
  assert.equal(await password.inputValue(), "");
  await page.waitForFunction(() => document.activeElement?.getAttribute("autocomplete") === "current-password");
  await stableScreenshot(page, "desktop-error");
  await page.getByRole("radio", { name: "深色", exact: true }).click();
  await checkLoginContrast(page);
  await page.getByRole("radio", { name: "浅色", exact: true }).click();
  pass("wrong credentials clear and focus password; visibility toggle");
  loginStatus = 429;
  retryAfter = 28;
  await password.fill("password1"); await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "请 28 秒后再试" }).waitFor();
  await stableScreenshot(page, "desktop-locked");
  assert(await page.getByRole("button", { name: /请 \d+ 秒后再试/ }).isDisabled());
  await page.clock.install();
  await page.reload();
  retryAfter = 2;
  await password.fill("password1"); await login.click();
  await page.getByRole("button", { name: "请 2 秒后再试" }).waitFor();
  await page.clock.runFor(1000);
  await page.getByRole("button", { name: "请 1 秒后再试" }).waitFor();
  await page.clock.runFor(1000);
  await password.fill("password2");
  assert.equal(await page.getByRole("alert").count(), 0, "editing clears the server error");
  await page.waitForFunction(() => !document.querySelector('button[type="submit"]').disabled);
  await page.clock.resume();
  pass("429 countdown and recovery");
  for (const [status, message] of [[503, "登录请求过多，请稍后再试"], [0, "无法连接板子，请检查网络后重试"]]) {
    loginStatus = status; await password.fill("password1"); await page.getByRole("button", { name: "登录", exact: true }).click(); await page.getByText(message, { exact: true }).waitFor();
  }
  pass("busy and network error messages");
  state.setupAllowed = false; await page.reload();
  await page.getByText(/此连接未加密/).waitFor();
  await stableScreenshot(page, "insecure-warning");
  state.secure = true; await page.reload(); await password.waitFor();
  assert.equal(await page.getByText(/此连接未加密/).count(), 0);
  pass("unencrypted warning only on insecure non-LAN access");
  state = { ...state, configured: false, setupAllowed: false };
  await page.reload(); await page.getByText("需要在局域网内完成设置", { exact: true }).waitFor(); assert.equal(await page.locator("form").count(), 0);
  await stableScreenshot(page, "setup-remote");
  pass("non-LAN setup guidance");
  state.setupAllowed = true; await page.reload();
  await password.waitFor();
  await stableScreenshot(page, "setup");
  assert.equal(await page.title(), "创建账户 · Khadas — VIM4 KVM");
  await username.fill("bad username");
  await password.fill("short");
  await page.getByLabel("确认密码", { exact: true }).fill("different");
  const create = page.getByRole("button", { name: "创建并登录" });
  const createBox = await create.boundingBox();
  // Keep confirmation focused until mousedown triggers its blur validation.
  await page.mouse.click(createBox.x + createBox.width / 2, createBox.y + createBox.height / 2);
  assert.equal(await page.locator('[aria-invalid="true"]').count(), 3);
  assert(await username.evaluate(element => element === document.activeElement));
  assert.deepEqual(await create.boundingBox(), createBox, "setup validation must not move the submit button");
  await stableScreenshot(page, "setup-errors");
  await page.getByRole("radio", { name: "深色", exact: true }).click();
  await checkLoginContrast(page);
  await page.getByRole("radio", { name: "浅色", exact: true }).click();
  await username.fill("bad username");
  const usernameBlurBox = await create.boundingBox();
  await page.mouse.click(usernameBlurBox.x + usernameBlurBox.width / 2, usernameBlurBox.y + usernameBlurBox.height / 2);
  assert.equal(await page.locator('[aria-invalid="true"]').count(), 3);
  assert(await username.evaluate(element => element === document.activeElement));
  assert.deepEqual(await create.boundingBox(), usernameBlurBox, "username blur must not move the submit button");
  await password.fill("short"); await password.blur(); await page.getByText("密码须为 8–128 个字符", { exact: true }).waitFor();
  await page.getByLabel("用户名", { exact: true }).fill("samepassword"); await password.fill("samepassword"); await password.blur(); await page.getByText("密码不能与用户名相同").waitFor();
  await page.getByLabel("用户名", { exact: true }).fill("admin"); await password.fill("password1"); await page.getByLabel("确认密码", { exact: true }).fill("different"); await page.getByLabel("确认密码", { exact: true }).blur(); await page.getByText("两次密码不一致").waitFor();
  assert(await page.getByRole("button", { name: "创建并登录" }).isEnabled());
  await page.getByLabel("确认密码", { exact: true }).fill("password1");
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await stableScreenshot(page, "setup-phone");
  pass("setup validation and 390px layout");
  setupStatus = 409; await page.getByRole("button", { name: "创建并登录" }).click(); await page.getByText("账户已被设置，请登录").waitFor();
  pass("concurrent setup switches to login");
  state.configured = true; loginStatus = 200;
  await password.fill("password1"); await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL(/#\/account$/);
  await page.getByText("经板上代理", { exact: true }).waitFor();
  await page.getByText(/上次修改 2026-10-18/).waitFor();
  const shot = name => stableScreenshot(page, name, true, accountShots);
  const menuButton = page.getByRole("button", { name: "账户菜单", exact: true });
  const menu = page.getByRole("menu", { name: "账户菜单" });
  await checkCompactHeader(page, 760);
  await checkCompactHeader(page, 390);
  await shot("phone-light");
  await menuButton.click();
  await menu.getByText("本设备 192.168.1.2", { exact: true }).waitFor();
  await shot("phone-menu");
  await page.keyboard.press("Escape");
  await focused(menuButton);
  await page.getByRole("button", { name: "打开菜单", exact: true }).click();
  await page.getByRole("radio", { name: "深色", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await shot("phone-dark");
  await page.setViewportSize({ width: 1440, height: 900 });
  await shot("account-dark");
  await checkAccountContrast(page);
  await menuButton.focus();
  await page.keyboard.press("Enter");
  await focused(menu.getByRole("menuitem").first());
  await page.keyboard.press("ArrowDown");
  await focused(menu.getByRole("menuitem").last());
  await page.keyboard.press("ArrowDown");
  await focused(menu.getByRole("menuitem").first());
  await page.keyboard.press("End");
  await page.keyboard.press("Home");
  await focused(menu.getByRole("menuitem").first());
  await shot("sidebar-menu-dark");
  await checkLoginContrast(page);
  await page.keyboard.press("Escape");
  await focused(menuButton);
  await page.getByRole("radio", { name: "浅色", exact: true }).click();
  await shot("account-light");
  await menuButton.click();
  await shot("sidebar-menu-light");
  await checkLoginContrast(page);
  // The menu leaves with Radix's short close animation.
  await page.getByRole("heading", { name: "账户", exact: true }).click();
  await menu.waitFor({ state: "detached" });
  await menuButton.click(); await page.keyboard.press("Tab");
  await menu.waitFor({ state: "detached" });
  await menuButton.click();
  await page.evaluate(() => { location.hash = "/updates"; });
  await menu.waitFor({ state: "detached" });
  assert.equal(await page.getByRole("navigation").getByRole("link", { name: "账户", exact: true }).count(), 0);
  await menuButton.click();
  await menu.getByRole("menuitem", { name: "账户与登录设备" }).click();
  await page.waitForURL(/#\/account$/);
  await page.getByText("经板上代理", { exact: true }).waitFor();
  logoutFail = true;
  await menuButton.click();
  await menu.getByRole("menuitem", { name: "退出登录" }).click();
  await menu.getByRole("alert").waitFor();
  logoutFail = false;
  await page.keyboard.press("Escape");
  pass("desktop and phone menu, keyboard wrapping, route/outside/Tab dismissal and logout failure");
  account.sessions.push({ ...otherDevice, id: "curl", address: "100.88.1.5", userAgent: "curl/8.7.1" });
  account.sessions.push({ ...otherDevice, id: "v6", address: "fd7a:115c:a1e0::1234", userAgent: "Playwright HeadlessChrome" });
  await page.reload();
  await page.getByText("命令行工具 · curl", { exact: true }).waitFor();
  assert.equal(await page.getByText("Tailscale", { exact: true }).count(), 2);
  await page.setViewportSize({ width: 2000, height: 1250 });
  await shot("account-wide");
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1440, height: 900 });
  const columns = await page.getByRole("table", { name: "登录设备" }).getByRole("row").filter({ has: page.getByRole("cell") }).evaluateAll(rows => rows.map(row => [...row.querySelectorAll('[role="cell"]')].map(cell => cell.getBoundingClientRect().x)));
  assert.deepEqual(columns[0].slice(0, 3), columns[1].slice(0, 3));
  let releaseSessions;
  sessionsWait = new Promise(resolve => { releaseSessions = resolve; });
  await page.reload();
  await page.getByRole("table", { name: "登录设备" }).locator("[data-slot=skeleton]").first().waitFor();
  assert.equal(await page.getByRole("table", { name: "登录设备" }).locator("[data-slot=skeleton]").count(), 9);
  sessionsFail = true; releaseSessions(); sessionsWait = undefined;
  await page.getByText("无法读取登录设备", { exact: false }).waitFor();
  sessionsFail = false;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.getByText("命令行工具 · curl", { exact: true }).waitFor();
  pass("tool names, Tailscale IPv4/IPv6, loopback, aligned columns and loading retry");
  revokeFail = true;
  const otherRow = page.getByRole("table", { name: "登录设备" }).getByRole("row").filter({ has: page.getByRole("cell") }).filter({ hasText: "经板上代理" });
  await otherRow.getByRole("button", { name: "退出", exact: true }).click();
  await otherRow.getByRole("alert").waitFor();
  revokeFail = false;
  await otherRow.getByRole("button", { name: "退出", exact: true }).click();
  await otherRow.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "退出其他设备", exact: true }).click();
  await page.getByText("其他 2 个设备将退出，正在使用的 KVM 连接会断开。", { exact: true }).waitFor();
  assert.equal(account.sessions.length, 3);
  await page.getByRole("button", { name: "确认退出", exact: true }).click();
  await page.getByText("仅本设备", { exact: true }).waitFor();
  await shot("account-single-device");
  assert.equal(account.sessions.length, 1);
  pass("per-device failure recovery and confirmed logout of other devices");
  account.sessions.push({ ...otherDevice }); await page.reload();
  const editPassword = page.getByRole("button", { name: "修改密码", exact: true });
  await editPassword.click();
  assert(await page.getByLabel("当前密码", { exact: true }).evaluate(el => el === document.activeElement));
  await shot("password-dialog");
  await page.keyboard.press("Escape");
  await focused(editPassword);
  assert(await editPassword.evaluate(el => el === document.activeElement));
  await editPassword.click();
  // Radix installs its outside-pointer listener on the next timer tick.
  await page.clock.runFor(1);
  await page.clock.resume();
  await page.mouse.click(1, 1);
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await focused(editPassword);
  assert(await editPassword.evaluate(el => el === document.activeElement));
  await page.getByRole("button", { name: "修改密码", exact: true }).click();
  await page.getByLabel("当前密码", { exact: true }).fill("wrong"); await page.getByLabel("新密码", { exact: true }).fill("newpassword"); await page.getByLabel("确认新密码", { exact: true }).fill("newpassword"); await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("dialog").getByText("当前密码错误", { exact: true }).waitFor();
  assert.match(page.url(), /#\/account$/);
  pass("wrong current password preserves the session and dialog");
  await page.getByLabel("当前密码", { exact: true }).fill("password1"); await page.getByLabel("新密码", { exact: true }).fill("newpassword"); await page.getByLabel("确认新密码", { exact: true }).fill("newpassword"); await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("密码已修改，其他设备已退出", { exact: true }).waitFor();
  assert.equal(writes.at(-1).body.password, "newpassword"); assert.equal(await page.getByRole("table", { name: "登录设备" }).getByRole("row").filter({ has: page.getByRole("cell") }).count(), 1);
  await shot("success-banner");
  await checkLoginContrast(page);
  await page.getByRole("radio", { name: "深色", exact: true }).click();
  await checkLoginContrast(page);
  await page.getByRole("radio", { name: "浅色", exact: true }).click();
  await page.clock.runFor(5000);
  assert.equal(await page.getByRole("status").filter({ hasText: "密码已修改，其他设备已退出" }).count(), 0);
  await page.clock.resume();
  pass("password change, focus restoration and success auto-dismissal");
  await page.getByRole("button", { name: "修改用户名", exact: true }).click(); await page.getByLabel("当前密码", { exact: true }).fill("newpassword"); await page.getByLabel("新用户名").fill("operator"); await page.getByRole("button", { name: "保存", exact: true }).click(); await page.getByText("用户名已修改，其他设备已退出", { exact: true }).waitFor();
  pass("username change updates account");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("radio", { name: "深色", exact: true }).click();
  await menuButton.click(); await menu.getByRole("menuitem", { name: "退出登录", exact: true }).click(); await page.waitForURL(/\/__vim4\/login/); await password.waitFor();
  pass("logout returns to login");
  for (const next of ["//evil.test", "/\\evil.test", "https://evil.test"]) {
    state.authenticated = true; await page.goto(`${base}/__vim4/login?next=${encodeURIComponent(next)}`); await page.waitForURL(`${base}/#/overview`);
    await page.getByRole("heading", { name: "概览", exact: true }).waitFor();
  }
  pass("unsafe next URLs stay on manager origin");
  state = { ...state, authenticated: false, configured: false, setupAllowed: true }; setupStatus = 200;
  await page.goto(`${base}/__vim4/login?next=${encodeURIComponent('/#/account')}`); await password.fill("password1"); await page.getByLabel("确认密码", { exact: true }).fill("password1"); await page.getByRole("button", { name: "创建并登录" }).click(); await page.waitForURL(/#\/account$/);
  pass("successful setup signs in");
  await page.getByRole("button", { name: "修改用户名", exact: true }).waitFor();
  await checkCompactHeader(page, 390);
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page.waitForURL(/\/__vim4\/login/);
  await password.waitFor();
  pass("account page logout remains available on narrow screens");
  state.authenticated = true;
  await page.goto(`${base}/#/account`);
  await page.getByRole("button", { name: "修改用户名", exact: true }).waitFor();
  state.authenticated = false;
  await page.route("**/api/account/sessions", route => route.fulfill({ status: 401, json: { error: "未登录" } }));
  // A running page discovers expiry through the shared request helper.
  await page.getByRole("button", { name: "修改用户名", exact: true }).click(); await page.getByLabel("当前密码", { exact: true }).fill("password1"); await page.getByLabel("新用户名").fill("admin"); await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.waitForURL(/\/__vim4\/login/); await password.waitFor();
  pass("API 401 redirects an already running application");
  console.log(`${count} auth scenarios passed; screenshots: ${shots}, ${accountShots}`);
} finally { await browser.close(); }
