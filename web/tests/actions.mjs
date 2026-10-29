import assert from "node:assert/strict";
import { fixtures } from "./ui-fixtures.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  await (await import("./auth-fixture.mjs")).pinLanguage(page);
  const data = fixtures();
  let failure = "Connection lost";
  await (await import("./auth-fixture.mjs")).authenticated(page);
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/__vim4/api/auth/state") return route.fulfill({ json: data.auth });
    if (route.request().method() === "POST") {
      if (path.endsWith("/preview")) return route.fulfill({ json: { ok: true } });
      return route.fulfill({ status: failure ? 400 : 200, json: failure ? { error: failure } : { ok: true } });
    }
    if (path === "/api/edid") return route.fulfill({ status: 400, json: { error: "Connection lost" } });
    return route.fulfill({ json: data.status });
  });
  await page.goto(`${process.env.TEST_URL || "http://127.0.0.1:5188"}/#/cooling`);
  await page.getByRole("button", { name: /Cool/ }).click();
  await page.getByRole("button", { name: "Apply curve" }).click();
  const notices = page.getByRole("region", { name: "Notifications" });
  await notices.getByText("Connection lost", { exact: true }).waitFor();
  await page.getByRole("link", { name: /Video input/ }).click();
  await page.getByRole("alert").getByText("Couldn't load EDID: Connection lost").waitFor();
  await notices.getByText("Connection lost", { exact: true }).waitFor({ state: "hidden" });
  const slider = page.getByRole("slider", { name: /Desktop brightness/ });
  async function save(key) {
    const response = page.waitForResponse((r) => r.url().endsWith("/api/hdr-curve") && r.request().method() === "POST");
    await slider.focus();
    await page.keyboard.press(key);
    await response;
    // Let the async action and Sonner publish their updates.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  await save("End");
  assert.equal(await notices.getByText("Connection lost", { exact: true }).count(), 0, "visible inline failure suppresses the same action toast");
  failure = "Couldn't save settings";
  await save("Home");
  await notices.getByText("Couldn't save settings", { exact: true }).waitFor();
  failure = "";
  await save("End");
  await notices.getByText(/^HDR mapping saved:/).waitFor();
  console.log("PASS: inline failures suppress matching action toasts, later inline errors dismiss them, distinct failures and success toasts remain");
} finally { await browser.close(); }
