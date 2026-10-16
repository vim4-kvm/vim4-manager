import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.clock.install();
  const apps = ["onekvm", "pikvm"].map((id) => ({ id, name: id === "pikvm" ? "PiKVM" : "One-KVM", port: 8080,
    description: "", unit: { name: id, loaded: true, active: id === "onekvm" ? "active" : "inactive", enabled: "enabled", sub: "running" } }));
  const status = { active: "onekvm", apps, platform: [],
    media: { known: true, inserted: true, name: "rescue.iso", cdrom: true, readOnly: true, connected: true, pikvm: false },
    hardware: { hostname: "vim4", kernel: "5.15", uptimeSeconds: 60, load1: 0, cpus: 8,
      memTotalKiB: 1024, memAvailableKiB: 512, tempC: 50, fanAuto: true, fanPercent: 30,
      zones: [], usb: "configured", hdmi: { signal: true, height: 1080, audio: true }, hdrCurve: { white: 203, peak: 1000 } },
    system: { links: [], disk: { totalBytes: 1024, freeBytes: 512 }, packages: [] }, history: [], events: [] };
  let failStatus = false;
  const selections = [];
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
  await page.goto(`${process.env.TEST_URL || "http://127.0.0.1:5188"}/#/apps`);
  await page.getByText("rescue.iso", { exact: true }).waitFor();
  const waitForEject = async () => {
    await page.getByRole("button", { name: "切换到此", exact: true }).click();
    await page.getByRole("button", { name: "弹出后继续切换", exact: true }).click();
    await page.getByRole("button", { name: "取消等待" }).waitFor();
    assert.deepEqual(selections, [], "waiting must not stop the current app");
  };
  await waitForEject();
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/media-desktop.png`, fullPage: true });
  await page.getByRole("button", { name: "取消等待" }).click();
  status.media.inserted = false;
  await poll();
  assert.deepEqual(selections, [], "cancelled wait cannot switch on later eject");

  status.media.inserted = true;
  await poll();
  await waitForEject();
  status.media.known = false;
  await poll();
  await page.getByText("已取消等待切换，请确认当前状态后重新选择。").waitFor();
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
  await page.getByRole("button", { name: "取消等待" }).waitFor({ state: "hidden" });
  status.active = "onekvm";
  await poll();
  assert.deepEqual(selections, [], "another operator's switch cancels waiting");

  await waitForEject();
  await Promise.all([page.waitForResponse("**/api/status"), page.clock.fastForward(301_000)]);
  await page.getByRole("button", { name: "取消等待" }).waitFor({ state: "hidden" });
  status.media.inserted = false;
  await poll();
  assert.deepEqual(selections, [], "expired wait cannot switch later");

  status.media.inserted = true;
  await poll();
  await waitForEject();
  status.media.inserted = false;
  await poll();
  await page.getByText("已切换到 PiKVM", { exact: true }).waitFor();
  await poll();
  assert.deepEqual(selections, ["pikvm"], "host eject submits exactly one normal switch");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/media-mobile.png`, fullPage: true });
  console.log("PASS: media wait, cancel, unknown state, network failure, navigation, one-shot switch and mobile layout");
} finally { await browser.close(); }
