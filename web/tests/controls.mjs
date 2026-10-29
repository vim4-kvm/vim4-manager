import assert from "node:assert/strict";
import { fixtures } from "./ui-fixtures.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.TEST_URL || "http://127.0.0.1:5188";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ reducedMotion: "reduce", viewport: { width: 1280, height: 900 } });
  await (await import("./auth-fixture.mjs")).pinLanguage(page);
  const data = fixtures();
  const errors = [], writes = [];
  data.status.platform[0].name = "HDMI capture";
  let releaseStatus;
  const firstBodyStarted = new Promise((resolve) => { releaseStatus = resolve; });
  await page.exposeFunction("firstDiskBodyStarted", () => releaseStatus());
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    // Hold the first LUN token until the disk body is decoding, even when its
    // production page chunk loads after the initial status request.
    if (path === "/api/status") await firstBodyStarted;
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      writes.push({ path, body });
      if (path === "/api/edid") Object.assign(data.edid, { selected: body.id, active: body.id });
      if (path === "/api/fan-curve") data.status.hardware.fanTriggers = body;
      if (path === "/api/hdr-curve") data.status.hardware.hdrCurve = body;
      if (path === "/api/hdr-mapping") data.status.hardware.hdrToSdr = body.enabled;
      return route.fulfill({ json: { ok: true } });
    }
    const responses = { "/__vim4/api/auth/state": data.auth, "/api/status": data.status, "/api/disks": data.disks,
      "/api/disks/files": data.files, "/api/edid": data.edid };
    return route.fulfill({ status: path in responses ? 200 : 404, json: responses[path] ?? {} });
  });
  // Abort during body decoding, as when the first LUN status replaces an in-flight read.
  // The request helper intentionally tolerates non-JSON bodies; a canceled read
  // must never commit its fallback object as a new disk list.
  await page.addInitScript(() => {
    const fetch = window.fetch;
    let firstDiskRead = true;
    window.fetch = function (url, options) {
      if (url === "/api/disks" && firstDiskRead) {
        firstDiskRead = false;
        return Promise.resolve({ ok: true, status: 200, json: () => new Promise((_, reject) => {
          void window.firstDiskBodyStarted();
          const abort = () => reject(new DOMException("aborted", "AbortError"));
          if (options.signal.aborted) abort();
          else options.signal.addEventListener("abort", abort, { once: true });
        }) });
      }
      return fetch.call(this, url, options);
    };
  });
  await page.goto(`${base}/#/disks`);
  await page.getByRole("button", { name: /^readme\.txt/ }).waitFor();
  assert.deepEqual(errors, [], "an aborted disk read cannot replace the current list or crash the page");

  await page.getByRole("link", { name: /Video input/ }).click();
  await page.getByRole("radio", { name: /VIM4 1080p60/ }).check();
  await page.getByRole("button", { name: "Apply preset" }).click();
  assert.equal(writes.length, 0, "choosing an EDID must wait for confirmation");
  await page.getByRole("alertdialog", { name: "Change EDID?" }).getByRole("button", { name: "Change EDID", exact: true }).click();
  await page.getByText("EDID changed to VIM4 1080p60. JetKVM settings are synced.", { exact: true }).waitFor();
  assert.deepEqual(writes.at(-1), { path: "/api/edid", body: { id: "VIM4-1080P60" } });
  const brightness = page.getByRole("slider", { name: /Desktop brightness/ });
  await brightness.focus();
  const savedHDR = page.waitForResponse((r) => r.url().endsWith("/api/hdr-curve") && r.request().method() === "POST");
  await page.keyboard.press("End");
  await savedHDR;
  const hdr = writes.findLast((write) => write.path === "/api/hdr-curve");
  assert(hdr && hdr.body.white <= 203 && hdr.body.peak === 1000);
  assert(writes.some((write) => write.path === "/api/hdr-curve/preview"), "keyboard editing previews before saving");
  const mapping = page.getByRole("switch", { name: "Enable HDR to SDR", exact: true });
  await mapping.click();
  await page.getByText("HDR to SDR disabled by default", { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector("[role=\"switch\"][aria-label=\"Enable HDR to SDR\"]")?.getAttribute('aria-checked') === 'false');
  assert(await brightness.isDisabled());
  await page.reload();
  await mapping.waitFor();
  assert.equal(await mapping.getAttribute("aria-checked"), "false");
  await mapping.click();
  await page.getByText("HDR to SDR enabled", { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('input[type="range"]')?.disabled);
  assert.deepEqual(writes.filter(w => w.path === "/api/hdr-mapping").map(w => w.body), [{enabled:false}, {enabled:true}]);

  await page.getByRole("link", { name: /Cooling/ }).click();
  const low = page.getByRole("spinbutton", { name: /Start temperature/ });
  await low.fill("90");
  await page.getByRole("alert").getByText(/Set Start temperature between/).waitFor();
  assert(await page.getByRole("button", { name: "Apply curve" }).isDisabled());
  await page.getByRole("button", { name: /Cool/ }).click();
  await page.getByRole("button", { name: "Apply curve" }).click();
  await page.getByText("Fan curve applied: 50 / 70 / 90 °C", { exact: true }).waitFor();
  assert.deepEqual(writes.at(-1), { path: "/api/fan-curve", body: { low: 50, mid: 70, high: 90 } });

  await page.getByRole("link", { name: /System services/ }).click();
  const previous = writes.length;
  await page.getByRole("row", { name: /HDMI capture/ }).getByRole("button", { name: "Restart service" }).click();
  assert.equal(writes.length, previous, "service restart requires confirmation");
  await page.getByRole("alertdialog").getByRole("button", { name: "Restart service", exact: true }).click();
  await page.getByText("HDMI capture restarted", { exact: true }).waitFor();
  assert.deepEqual(writes.at(-1), { path: "/api/restart", body: { unit: "vim4-hdmi.service" } });
  assert.deepEqual(errors, []);
  console.log("PASS: canceled disk reads, EDID confirmation, HDR keyboard preview/save, fan validation and confirmed service restart");
} finally { await browser.close(); }
