import assert from "node:assert/strict";
import { fixtures } from "./ui-fixtures.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  const data = fixtures();
  let failure = "连接中断";
  await (await import("./auth-fixture.mjs")).authenticated(page);
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/__vim4/api/auth/state") return route.fulfill({ json: data.auth });
    if (route.request().method() === "POST") {
      if (path.endsWith("/preview")) return route.fulfill({ json: { ok: true } });
      return route.fulfill({ status: failure ? 400 : 200, json: failure ? { error: failure } : { ok: true } });
    }
    if (path === "/api/edid") return route.fulfill({ status: 400, json: { error: "连接中断" } });
    return route.fulfill({ json: data.status });
  });
  await page.goto(`${process.env.TEST_URL || "http://127.0.0.1:5188"}/#/cooling`);
  await page.getByRole("button", { name: /凉爽/ }).click();
  await page.getByRole("button", { name: "应用曲线" }).click();
  const notices = page.getByRole("region", { name: "通知" });
  await notices.getByText("连接中断", { exact: true }).waitFor();
  await page.getByRole("link", { name: /视频输入/ }).click();
  await page.getByRole("alert").getByText("读取失败：连接中断").waitFor();
  await notices.getByText("连接中断", { exact: true }).waitFor({ state: "hidden" });
  const slider = page.getByRole("slider", { name: /桌面亮度/ });
  async function save(key) {
    const response = page.waitForResponse((r) => r.url().endsWith("/api/hdr-curve") && r.request().method() === "POST");
    await slider.focus();
    await page.keyboard.press(key);
    await response;
    // Let the async action and Sonner publish their updates.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  await save("End");
  assert.equal(await notices.getByText("连接中断", { exact: true }).count(), 0, "visible inline failure suppresses the same action toast");
  failure = "保存被拒绝";
  await save("Home");
  await notices.getByText("保存被拒绝", { exact: true }).waitFor();
  failure = "";
  await save("End");
  await notices.getByText(/^HDR 映射已保存：/).waitFor();
  console.log("PASS: inline failures suppress matching action toasts, later inline errors dismiss them, distinct failures and success toasts remain");
} finally { await browser.close(); }
