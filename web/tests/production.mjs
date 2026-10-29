// Test the emitted assets through Vite's production preview, with mocked APIs.
// --screens also regenerates the complete localization review matrix.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { preview } from "vite";
import { fixtures, localizeResponse } from "./ui-fixtures.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const server = await preview({ root: fileURLToPath(new URL("../", import.meta.url)), preview: { host: "127.0.0.1", port: 0 } });
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
let count = 0;
try {
  for (const locale of ["en", "zh-CN"]) for (const login of [false, true]) {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    await context.addInitScript(locale => localStorage.setItem("vim4-manager-language", locale), locale);
    const data = fixtures(locale);
    data.auth.authenticated = !login;
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) return route.abort();
      if (!url.pathname.includes("/api/")) return route.continue();
      const value = { "/__vim4/api/auth/state": data.auth, "/api/status": data.status }[url.pathname];
      return route.fulfill({ status: value ? 200 : 404, json: localizeResponse(url.pathname, value, route.request().headers().cookie) ?? { error: "Unexpected fixture API" } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}/${login ? "__vim4/login" : "#/overview"}`);
    await page.getByRole("button", { name: /Language/ }).waitFor();
    await page.locator("img").first().waitFor();
    const images = await page.locator("img").evaluateAll(async images => {
      await Promise.all(images.map(image => image.decode()));
      return images.map(image => ({ src: image.src, width: image.naturalWidth }));
    });
    assert(images.length > 0 && images.every(image => image.width > 0), JSON.stringify(images));
    const favicon = new URL(await page.locator('link[rel="icon"]').getAttribute("href"), base).href;
    const response = await context.request.get(favicon);
    assert.equal(response.status(), 200);
    assert.match(response.headers()["content-type"], /^image\/svg\+xml/);
    assert(await page.evaluate(async src => {
      const image = new Image();
      image.src = src;
      await image.decode();
      return image.naturalWidth > 0;
    }, favicon), "favicon decodes");
    const expected = login ? locale === "en" ? "Sign in · VIM4 KVM" : "登录 · VIM4 KVM" : "VIM4 KVM";
    await page.waitForFunction(title => document.title === title, expected);
    if (login) {
      await page.getByRole("button", { name: /Language/ }).click();
      await page.getByRole("menuitemradio", { name: locale === "en" ? "简体中文" : "English", exact: true }).click();
      await page.waitForFunction(title => document.title === title, locale === "en" ? "登录 · VIM4 KVM" : "Sign in · VIM4 KVM");
    }
    assert.deepEqual(errors, []);
    await context.close();
    count++;
  }
  console.log(`PASS: ${count} production main/login locale scenarios; every image and both favicons decode; localized login titles switch live`);
  if (process.argv.includes("--screens")) {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./i18n-screens.mjs", import.meta.url))], {
      env: { ...process.env, TEST_URL: base }, stdio: "inherit",
    });
    assert.equal(await new Promise(resolve => child.on("close", resolve)), 0, "production screenshot matrix");
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
