import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.TEST_URL || "http://127.0.0.1:5188";
const shots = new URL("../../../logs/unified-auth/shots-login/", import.meta.url).pathname;
await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
let count = 0;
function pass(name) { console.log(`PASS ${++count}: ${name}`); }

async function stableScreenshot(page, name, fullPage = true) {
  await page.waitForFunction(() => {
    const themeSettled = !document.documentElement.classList.contains("theme-switching");
    const noDialog = !document.querySelector(".auth-modal");
    const animationsSettled = document.getAnimations().every(animation =>
      animation.playState !== "running" || animation.effect.getTiming().iterations === Infinity);
    return themeSettled && noDialog && animationsSettled;
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage });
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
    return [[".account-card h3", ".account-card"], [".account-card p", ".account-card"], [".brand-mark", ".sidebar"]].map(([text, background]) => {
      const foreground = luminance(getComputedStyle(document.querySelector(text)).color);
      const surface = luminance(getComputedStyle(document.querySelector(background)).backgroundColor);
      return (Math.max(foreground, surface) + 0.05) / (Math.min(foreground, surface) + 0.05);
    });
  });
  assert(contrasts.every(value => value >= 4.5), `account and brand contrast: ${contrasts}`);
}

async function checkCompactHeader(page, width) {
  await page.setViewportSize({ width, height: 844 });
  const icon = await page.locator(".brand .account-link-compact").boundingBox();
  const theme = await page.locator(".brand .theme-switch-compact").boundingBox();
  assert(icon && theme);
  assert(icon.x + icon.width <= theme.x, "account icon precedes theme control");
  assert(Math.abs(icon.y + icon.height / 2 - theme.y - theme.height / 2) <= 1, "header controls vertically align");
  assert(await page.locator(".sidebar-foot").isHidden());
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
    return [".auth-identity h1", ".auth-field label", ".auth-card input", ".auth-submit",
      ".auth-forgot", ".auth-message", ".auth-command", ".auth-field-error", ".auth-setup p",
      ".auth-warning", ".auth-identity p", ".auth-hint"].flatMap(selector =>
      [...document.querySelectorAll(selector)].map(element => {
        const foreground = luminance(rgba(getComputedStyle(element).color));
        const surface = luminance(background(element));
        return { selector, ratio: (Math.max(foreground, surface) + .05) / (Math.min(foreground, surface) + .05),
          minimum: [".auth-identity p", ".auth-hint"].includes(selector) ? 3 : 4.5 };
      }));
  });
  for (const value of values) assert(value.ratio >= value.minimum, JSON.stringify(value));
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "UTC" });
  let state = { configured: true, authenticated: false, username: "admin", secure: false, setupAllowed: true, retryAfter: 0, hostname: "Khadas" };
  let stateFails = false;
  let releaseState;
  let stateRequested;
  let holdState = false;
  let loginRequests = 0;
  let retryAfter = 2;
  let loginStatus = 401;
  let account = { username: "admin", passwordChanged: "2026-10-18T12:00:00Z", sessions: [
    { id: "current", current: true, address: "192.168.1.2", userAgent: "Mozilla Macintosh Chrome/120", lastActive: new Date().toISOString() },
    { id: "other", current: false, address: "127.0.0.1", userAgent: "Mozilla iPhone Safari/17", lastActive: new Date(Date.now() - 7200000).toISOString() },
  ] };
  const otherDevice = { ...account.sessions[1] };
  const writes = [];
  await page.route("**/api/**", route => route.fulfill({ status: 404, json: {} }));
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
  await page.route("**/__vim4/api/auth/logout", route => { state.authenticated = false; return route.fulfill({ json: { ok: true } }); });
  await page.route("**/api/account/**", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: account });
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("password") && route.request().postDataJSON().currentPassword === "wrong") return route.fulfill({ status: 403, json: { error: "当前密码错误" } });
    writes.push({ path, body: route.request().postDataJSON() });
    if (path.endsWith("password") || path.endsWith("logout-others")) account.sessions = account.sessions.filter(d => d.current);
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
  const card = await page.locator(".auth-card").boundingBox();
  const identity = page.locator(".auth-identity");
  const identityBox = await identity.boundingBox();
  assert.equal(identityBox.y, 180, "desktop identity starts at 20vh");
  assert.equal(card.width, 400);
  assert.equal(card.x + card.width / 2, 720, "login centers across the full viewport");
  for (const [width, height, top] of [[480, 200, 48], [479, 900, 108]]) {
    await page.setViewportSize({ width, height });
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
  for (const selector of ["#password", ".password-field button", ".auth-submit", ".auth-forgot", ".auth-theme [tabindex='0']"]) {
    await page.keyboard.press("Tab");
    assert(await page.locator(selector).evaluate(element => element === document.activeElement), selector);
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
  assert.equal(await page.locator(".auth-skeleton").count(), 4);
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
  assert.equal(await page.locator(".auth-submit .spinner").evaluate(element => getComputedStyle(element).animationName), "none");
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
  await page.waitForFunction(() => !document.querySelector('button.primary').disabled);
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
  await page.waitForURL(/#\/account$/); await page.getByText(/本设备/).waitFor(); await page.getByText(/127.0.0.1\(转发\)/).waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByText("密码　上次修改 2026-10-18", { exact: true }).waitFor();
  await checkCompactHeader(page, 760);
  await checkCompactHeader(page, 390);
  await page.locator(".brand .account-link-compact").click();
  assert.match(page.url(), /#\/account$/);
  await stableScreenshot(page, "account-phone");
  await checkAccountContrast(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const columns = await page.locator(".account-device").evaluateAll(rows => rows.map(row =>
    [...row.children].map(cell => ({ x: cell.getBoundingClientRect().x, right: cell.getBoundingClientRect().right }))));
  assert.equal(columns[0].length, 4);
  for (let i = 0; i < 3; i++) {
    assert(columns[0][i].right < columns[0][i + 1].x);
    assert.equal(columns[0][i].x, columns[1][i].x, "desktop columns align across devices");
  }
  assert.equal(columns[0][3].right, columns[1][3].right, "actions align right");
  await stableScreenshot(page, "account-light", false);
  await page.getByRole("radio", { name: "深色", exact: true }).click();
  await stableScreenshot(page, "account-dark", false);
  await checkAccountContrast(page);
  await checkCompactHeader(page, 390);
  await stableScreenshot(page, "account-phone-dark");
  await checkAccountContrast(page);
  await page.getByRole("radio", { name: "浅色", exact: true }).click();
  pass("fixed date, four desktop columns, compact header and stable light/dark contrast");
  pass("login, device list, forwarded address and narrow account page");
  await page.locator(".account-device").getByRole("button", { name: "退出", exact: true }).click();
  await page.getByText("设备已退出", { exact: true }).waitFor();
  assert.equal(account.sessions.length, 1);
  account.sessions.push({ ...otherDevice }); await page.reload();
  await page.getByRole("button", { name: "退出其他设备", exact: true }).click();
  await page.getByText("其他 1 个设备将退出，正在使用的 KVM 连接会断开。", { exact: true }).waitFor();
  assert.equal(account.sessions.length, 2, "confirmation must precede revocation");
  await page.getByRole("button", { name: "确认退出", exact: true }).click();
  await page.getByText("其他设备已退出", { exact: true }).waitFor();
  assert.equal(account.sessions.length, 1);
  pass("single-device logout and confirmed logout of other devices");
  account.sessions.push({ ...otherDevice }); await page.reload();
  await page.getByRole("button", { name: "修改密码", exact: true }).click();
  await page.getByLabel("当前密码", { exact: true }).fill("wrong"); await page.getByLabel("新密码", { exact: true }).fill("newpassword"); await page.getByLabel("确认新密码", { exact: true }).fill("newpassword"); await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("dialog").getByText("当前密码错误", { exact: true }).waitFor();
  assert.match(page.url(), /#\/account$/);
  pass("wrong current password preserves the session and dialog");
  await page.getByLabel("当前密码", { exact: true }).fill("password1"); await page.getByLabel("新密码", { exact: true }).fill("newpassword"); await page.getByLabel("确认新密码", { exact: true }).fill("newpassword"); await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("密码已修改，其他设备已退出", { exact: true }).waitFor();
  assert.equal(writes.at(-1).body.password, "newpassword"); assert.equal(await page.locator(".account-device").count(), 1);
  pass("password change and other-device revocation");
  await page.getByRole("button", { name: "修改用户名", exact: true }).click(); await page.getByLabel("当前密码", { exact: true }).fill("newpassword"); await page.getByLabel("新用户名").fill("operator"); await page.getByRole("button", { name: "保存", exact: true }).click(); await page.getByText("用户名已修改，其他设备已退出", { exact: true }).waitFor();
  pass("username change updates account");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("radio", { name: "深色", exact: true }).click();
  await page.locator(".account-foot").getByRole("button", { name: "退出", exact: true }).click(); await page.waitForURL(/\/__vim4\/login/); await password.waitFor();
  pass("logout returns to login");
  for (const next of ["//evil.test", "/\\evil.test", "https://evil.test"]) {
    state.authenticated = true; await page.goto(`${base}/__vim4/login?next=${encodeURIComponent(next)}`); await page.waitForURL(`${base}/#/overview`);
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
  console.log(`${count} auth scenarios passed; screenshots: ${shots}`);
} finally { await browser.close(); }
