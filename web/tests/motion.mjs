import assert from "node:assert/strict";
import { fixtures } from "./ui-fixtures.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.TEST_URL || "http://127.0.0.1:5188";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ reducedMotion: "no-preference", viewport: { width: 1280, height: 900 } });
  const data = fixtures(), errors = [];
  let reads = 0;
  let output = { supported: true, enabled: true, audio: true, hdr: true, state: "running", audioState: "running",
    input: { width: 3840, height: 2160, refreshHz: 60, hdr: "SDR", colorFormat: "YCbCr 4:4:4", audio: true },
    monitor: { name: "DELL U2723QE", maxWidth: 3840, maxHeight: 2160, maxRefreshHz: 60, hdr: true, audio: true },
    output: { width: 3840, height: 2160, refreshHz: 60, colorFormat: "YCbCr 4:4:4", scaled: false, hdrToSdr: false } };
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/passthrough") { reads++; return route.fulfill({ json: output }); }
    const responses = { "/__vim4/api/auth/state": data.auth, "/api/status": data.status, "/api/edid": data.edid };
    return route.fulfill({ status: path in responses ? 200 : 404, json: responses[path] ?? {} });
  });
  const settle = () => page.waitForFunction(() => document.getAnimations().every((animation) => animation.effect.getTiming().iterations === Infinity || animation.playState !== "running"));
  const state = page.getByRole("group", { name: "透传", exact: true }).getByRole("status");
  await page.goto(`${base}/#/output`);
  await state.getByText("透传中", { exact: true }).waitFor();
  await settle();
  await state.evaluate((element) => {
    window.sameStateText = element.firstElementChild;
    window.textReplacements = 0;
    window.stateObserver = new MutationObserver((changes) => { window.textReplacements += changes.filter((change) => change.type === "childList").length; });
    window.stateObserver.observe(element, { childList: true });
  });
  await page.waitForResponse((response) => response.url().endsWith("/api/passthrough"));
  await settle();
  assert(await state.evaluate((element) => element.firstElementChild === window.sameStateText && window.textReplacements === 0), "identical polls keep the same text node without another fade");
  output = { ...output, state: "no-signal", input: undefined, output: undefined };
  await state.getByText("等待输入信号", { exact: true }).waitFor();
  await settle();
  assert.equal(await state.textContent(), "等待输入信号");
  await page.getByRole("link", { name: /视频输入/ }).click();
  await page.getByRole("heading", { name: "视频输入", exact: true }).waitFor();
  await settle();
  assert.equal(await page.getByRole("main").getByRole("heading", { level: 1 }).count(), 1, "wait-mode navigation leaves one page header");
  const horizontalOffset = await page.getByRole("main").locator(":scope > div").evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).m41);
  assert.equal(horizontalOffset, 0, "navigation never slides horizontally");
  const stoppedAt = reads;
  await page.waitForResponse((response) => response.url().endsWith("/api/status"));
  assert.equal(reads, stoppedAt, "the outgoing page releases its polling when the fade finishes");
  await page.getByRole("link", { name: /KVM 界面/ }).click();
  await page.getByText("开机启用", { exact: true }).waitFor();
  data.status.apps.push({ ...data.status.apps[0], id: "fixture", name: "Fixture app" });
  await page.getByRole("group", { name: "Fixture app", exact: true }).waitFor();
  data.status.apps = data.status.apps.filter((app) => app.id !== "fixture");
  await page.getByRole("group", { name: "Fixture app", exact: true }).waitFor({ state: "detached" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("link", { name: /HDMI 输出/ }).click();
  await state.getByText("等待输入信号", { exact: true }).waitFor();
  assert.equal(await state.evaluate((element) => element.getAnimations({ subtree: true }).length), 0, "reduced motion omits status fades");
  assert.deepEqual(errors, []);
  console.log("PASS: unchanged poll identity, changed-state fade, wait-mode page navigation, polling cleanup, lazy list layout/enter/exit and reduced motion");
} finally { await browser.close(); }
