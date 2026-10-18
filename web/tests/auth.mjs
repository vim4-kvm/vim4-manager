import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.TEST_URL || "http://127.0.0.1:5188";
const shots = new URL("../../../logs/unified-auth/shots-b/", import.meta.url).pathname;
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

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC" });
  let state = { configured: true, authenticated: false, username: "admin", secure: false, setupAllowed: true, retryAfter: 0, hostname: "vim4" };
  let loginStatus = 401;
  let account = { username: "admin", passwordChanged: "2026-10-18T12:00:00Z", sessions: [
    { id: "current", current: true, address: "192.168.1.2", userAgent: "Mozilla Macintosh Chrome/120", lastActive: new Date().toISOString() },
    { id: "other", current: false, address: "127.0.0.1", userAgent: "Mozilla iPhone Safari/17", lastActive: new Date(Date.now() - 7200000).toISOString() },
  ] };
  const otherDevice = { ...account.sessions[1] };
  const writes = [];
  await page.route("**/api/**", route => route.fulfill({ status: 404, json: {} }));
  await page.route("**/__vim4/api/auth/state", route => route.fulfill({ json: state }));
  await page.route("**/__vim4/api/auth/login", route => {
    if (loginStatus === 0) return route.abort();
    if (loginStatus === 200) state.authenticated = true;
    return route.fulfill({ status: loginStatus, json: { error: "用户名或密码错误", retryAfter: 2 } });
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
  await page.getByRole("heading", { name: "登录", exact: true }).waitFor();
  pass("unauthenticated startup redirects with hash route");
  const password = page.getByLabel("密码", { exact: true });
  await password.fill("wrong-password");
  await page.getByRole("button", { name: "显示密码" }).click();
  assert.equal(await password.getAttribute("type"), "text");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByText("用户名或密码错误", { exact: true }).waitFor();
  assert.equal(await password.inputValue(), "");
  await page.waitForFunction(() => document.activeElement?.getAttribute("autocomplete") === "current-password");
  pass("wrong credentials clear and focus password; visibility toggle");
  loginStatus = 429;
  await password.fill("password1"); await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByText("尝试次数过多，请 2 秒后再试").waitFor();
  assert(await page.getByRole("button", { name: "登录", exact: true }).isDisabled());
  await page.getByText("尝试次数过多，请 1 秒后再试").waitFor();
  await password.fill("password1");
  await page.waitForFunction(() => !document.querySelector('button.primary').disabled);
  pass("429 countdown and recovery");
  for (const [status, message] of [[503, "登录请求过多，请稍后再试"], [0, "无法连接板子，请检查网络后重试"]]) {
    loginStatus = status; await password.fill("password1"); await page.getByRole("button", { name: "登录", exact: true }).click(); await page.getByText(message, { exact: true }).waitFor();
  }
  pass("busy and network error messages");
  state.setupAllowed = false; await page.reload();
  await page.getByText(/此连接未加密/).waitFor();
  await stableScreenshot(page, "login-warning");
  state.secure = true; await page.reload(); await password.waitFor();
  assert.equal(await page.getByText(/此连接未加密/).count(), 0);
  pass("unencrypted warning only on insecure non-LAN access");
  state = { ...state, configured: false, setupAllowed: false };
  await page.reload(); await page.getByText(/请在局域网内打开此页面/).waitFor(); assert.equal(await page.locator("form").count(), 0);
  await stableScreenshot(page, "setup-remote");
  pass("non-LAN setup guidance");
  state.setupAllowed = true; await page.reload();
  await password.fill("short"); await password.blur(); await page.getByText("密码须为 8–128 个字符", { exact: true }).waitFor();
  await page.getByLabel("用户名", { exact: true }).fill("samepassword"); await password.fill("samepassword"); await password.blur(); await page.getByText("密码不能与用户名相同").waitFor();
  await page.getByLabel("用户名", { exact: true }).fill("admin"); await password.fill("password1"); await page.getByLabel("确认密码", { exact: true }).fill("different"); await page.getByLabel("确认密码", { exact: true }).blur(); await page.getByText("两次密码不一致").waitFor();
  assert(await page.getByRole("button", { name: "创建并登录" }).isDisabled());
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
