import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await (await import("./auth-fixture.mjs")).pinLanguage(page);
  await page.clock.install();
  const apps = ["onekvm", "pikvm"].map((id) => ({ id, name: id === "pikvm" ? "PiKVM" : "One-KVM", port: 8080,
    description: "", unit: { name: id, loaded: true, active: id === "onekvm" ? "active" : "inactive", enabled: "enabled", sub: "running" } }));
  const status = { active: "onekvm", apps, platform: [],
    media: { known: true, inserted: true, token: "mounted", name: "rescue.iso", cdrom: true, readOnly: true, connected: true, pikvm: false },
    hardware: { hostname: "vim4", kernel: "5.15", uptimeSeconds: 60, load1: 0, cpus: 8,
      memTotalKiB: 1024, memAvailableKiB: 512, tempC: 50, fanAuto: true, fanPercent: 30,
      zones: [], usb: "configured", hdmi: { signal: true, height: 1080, audio: true }, hdrCurve: { white: 203, peak: 1000 } },
    system: { links: [], disk: { totalBytes: 1024, freeBytes: 512 }, packages: [] }, history: [], events: [] };
  let failStatus = false;
  const selections = [];
  await page.route("**/api/media", route => route.fulfill({ json: [
    { id: "shared/test.img", name: "test.img", source: "shared", size: 1048576, cdrom: false },
    { id: "shared/installer.iso", name: "installer.iso", source: "shared", size: 1048576, cdrom: true },
  ] }));
  const mediaRequests = [];
  await page.route("**/api/media/*", route => {
    mediaRequests.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    return route.fulfill({ status: 400, json: { error: "The target computer still locks the disk. Safely eject it and try again." } });
  });
  await page.route("**/api/status", (route) => route.fulfill(failStatus
    ? { status: 503, json: { error: "offline" } } : { json: status }));
  await page.route("**/api/select", (route) => {
    selections.push(route.request().postDataJSON().app);
    return route.fulfill({ json: { ok: true } });
  });
  const poll = async () => {
    await Promise.all([page.waitForResponse("**/api/status"), page.clock.runFor(3100)]);
    await page.clock.runFor(50);
  };
  const image = (name) => page.getByRole("radio", { name: new RegExp(name.replace(".", "\\.")) });
  await (await import("./auth-fixture.mjs")).authenticated(page);
  await page.goto(`${process.env.TEST_URL || "http://127.0.0.1:5188"}/#/apps`);
  await page.getByRole("link", { name: /rescue\.iso/ }).click();
  await page.getByRole("heading", { name: "rescue.iso" }).waitFor();
  await image("test.img").check();
  assert.equal(await page.getByRole("button", { name: "Mount image", exact: true }).isDisabled(), true);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/media-page.png`, fullPage: true });
  await page.getByRole("button", { name: "Eject…", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Eject virtual disk", exact: true }).isDisabled(), true);
  await page.getByLabel("The target computer has stopped using the disk and safely unmounted it").check();
  await page.getByRole("button", { name: "Eject virtual disk", exact: true }).click();
  await page.getByText("The target computer still locks the disk. Safely eject it and try again.", { exact: true }).waitFor();
  assert.deepEqual(mediaRequests, [{ path: "/api/media/eject", body: { token: "mounted", confirmed: true } }]);
  assert.equal(await page.getByRole("button", { name: "Eject virtual disk", exact: true }).isDisabled(), true);
  await page.evaluate(() => { location.hash = "#/apps"; });
  const waitForEject = async () => {
    await page.getByRole("button", { name: "Switch to PiKVM", exact: true }).click();
    await page.getByRole("button", { name: "Switch after ejection", exact: true }).click();
    await page.getByRole("button", { name: "Cancel wait" }).waitFor();
    assert.deepEqual(selections, [], "waiting must not stop the current app");
  };
  await waitForEject();
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/media-desktop.png`, fullPage: true });
  await page.getByRole("button", { name: "Cancel wait" }).click();
  status.media.inserted = false;
  await poll();
  assert.deepEqual(selections, [], "cancelled wait cannot switch on later eject");

  status.media.inserted = true;
  await poll();
  await waitForEject();
  status.media.known = false;
  await poll();
  await page.getByText("Switch canceled. Check the current status and choose an interface again.").waitFor();
  status.media = { ...status.media, known: true, inserted: false };
  await poll();
  assert.deepEqual(selections, [], "unknown state must cancel, not look ejected");

  status.media.inserted = true;
  await poll();
  await waitForEject();
  failStatus = true;
  await poll();
  failStatus = false;
  status.media.inserted = false;
  await poll();
  assert.deepEqual(selections, [], "network recovery cannot revive a cancelled wait");

  status.media.inserted = true;
  await poll();
  await waitForEject();
  await page.evaluate(() => { location.hash = "#/overview"; });
  status.media.inserted = false;
  await poll();
  assert.deepEqual(selections, [], "leaving the page cancels waiting");
  await page.evaluate(() => { location.hash = "#/apps"; });

  status.media.inserted = true;
  await poll();
  await waitForEject();
  status.active = "pikvm";
  await poll();
  await page.getByRole("button", { name: "Cancel wait" }).waitFor({ state: "hidden" });
  status.active = "onekvm";
  await poll();
  assert.deepEqual(selections, [], "another operator's switch cancels waiting");

  await waitForEject();
  await Promise.all([page.waitForResponse("**/api/status"), page.clock.fastForward(301_000)]);
  await page.getByRole("button", { name: "Cancel wait" }).waitFor({ state: "hidden" });
  status.media.inserted = false;
  await poll();
  assert.deepEqual(selections, [], "expired wait cannot switch later");

  status.media.inserted = true;
  await poll();
  await waitForEject();
  status.media.inserted = false;
  await poll();
  await page.getByText("Switched to PiKVM", { exact: true }).waitFor();
  await poll();
  assert.deepEqual(selections, ["pikvm"], "host eject submits exactly one normal switch");
  await page.evaluate(() => { location.hash = "#/media"; });
  await page.getByRole("heading", { name: "No media mounted" }).waitFor();
  await image("installer.iso").check();
  const readonly = page.getByRole("checkbox", { name: /Mount read-only/ });
  assert.equal(await readonly.isDisabled(), true);
  assert.equal(await readonly.isChecked(), true);
  await image("test.img").check();
  assert.equal(await readonly.isChecked(), true);
  await readonly.uncheck();
  await page.getByRole("button", { name: "Mount image", exact: true }).click();
  await page.getByText("The target computer still locks the disk. Safely eject it and try again.", { exact: true }).waitFor();
  assert.deepEqual(mediaRequests.at(-1), { path: "/api/media/mount", body: { app: "onekvm", image: "shared/test.img", cdrom: false, readOnly: false } });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/media-mobile.png`, fullPage: true });
  console.log("PASS: media wait, cancel, unknown state, network failure, navigation, one-shot switch and mobile layout");
} finally { await browser.close(); }
