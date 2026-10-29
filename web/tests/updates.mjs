import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const shots = process.env.SCREENSHOTS;
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  await (await import("./auth-fixture.mjs")).pinLanguage(page);
  const development = "2.5.1+vim4.20261016.1020.dev.9.g49c45f2.dirty";
  let managerLatest = "2.5.1+vim4.20261016.1020";
  const unit = { name: "vim4-pikvm.service", loaded: true, active: "active", sub: "running", enabled: "enabled" };
  const status = {
    active: "pikvm", apps: [{ id: "pikvm", name: "PiKVM", unit, description: "", port: 8080 }], platform: [],
    hardware: { hostname: "vim4", kernel: "5.15.137", uptimeSeconds: 60, load1: 0, cpus: 8, memTotalKiB: 1, memAvailableKiB: 1,
      tempC: 50, zones: [], fanAuto: true, fanPercent: 30, usb: "configured", hdmi: { signal: true, height: 1080, audio: true },
      hdrCurve: { white: 203, peak: 1000 } },
    system: { links: [], disk: { totalBytes: 1, freeBytes: 1 }, packages: [{ name: "vim4-manager", version: development }, { name: "vim4-pikvm", version: development }] }, history: [], events: [],
  };
  let pikvm = "2.5.1+vim4.20261015.63";
  const installs = [];
  const switches = [];
  let kernelRelease = "7.3.0-vim4kvm-uhd1+";
  await page.route("**/api/kernel", async route => {
    if (route.request().method() === "POST") {
      switches.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { running: kernelRelease, kernels: [
      { id: "vendor", name: "Linux 5.15", release: "5.15.137", selected: false, available: true, error: "" },
      { id: "mainline", name: "Linux 7.x", release: kernelRelease, selected: true, available: true, error: "" },
    ] } });
  });
  await page.route("**/api/status", (route) => route.fulfill({ json: status }));
  await page.route("**/api/updates", async (route) => {
    if (route.request().method() === "POST") {
      installs.push(route.request().postDataJSON().package);
      pikvm = "2.5.1+vim4.20261016.1";
      return route.fulfill({ json: { ok: true } });
    }
    const latest = "2.5.1+vim4.20261016.1";
    return route.fulfill({ json: [
      { package: "vim4-nanokvm", name: "NanoKVM", repo: "NanoKVM", installed: "2.5.1+vim4.20261015.62", latest, available: true, selfService: true },
      { package: "vim4-jetkvm", name: "JetKVM", repo: "kvm", installed: "", available: false, selfService: true },
      { package: "vim4-onekvm", name: "One-KVM", repo: "One-KVM", installed: "2.5.1+vim4.20261015.62", available: false, selfService: true, error: "No release published yet" },
      { package: "vim4-pikvm", name: "PiKVM", repo: "kvmd", installed: pikvm, latest, available: pikvm !== latest, selfService: false },
      { package: "vim4-manager", name: "Manager", repo: "vim4-manager", installed: development, latest: managerLatest,
        available: managerLatest !== "2.5.1+vim4.20261016.1020", selfService: false },
    ] });
  });
  await (await import("./auth-fixture.mjs")).authenticated(page);
  await page.goto(`${process.env.TEST_URL || "http://127.0.0.1:5188"}/#/updates`);
  await page.getByRole("heading", { name: "Updates", exact: true }).waitFor();
  const kernelPanel = page.getByRole("region", { name: "Kernel", exact: true });
  await kernelPanel.locator('[data-slot="badge"]').getByText("Running", { exact: true }).waitFor();
  await kernelPanel.getByText("Stable", { exact: true }).waitFor();
  await kernelPanel.getByRole("button", { name: "Restart this kernel", exact: true }).waitFor();
  kernelRelease = "7.3.0-rc7-vim4kvm-uhd1+";
  await page.reload();
  await kernelPanel.getByText(kernelRelease, { exact: true }).last().waitFor();
  assert.equal(await kernelPanel.getByText("Stable", { exact: true }).count(), 0);
  kernelRelease = "7.3.0-vim4kvm-uhd1+";
  await page.reload();
  await kernelPanel.getByText("Stable", { exact: true }).waitFor();
  await kernelPanel.getByRole("button", { name: "Switch and restart", exact: true }).click();
  await page.getByRole("alertdialog").waitFor();
  assert.deepEqual(switches, [], "choosing a kernel cannot immediately reboot");
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("alertdialog").waitFor({ state: "hidden" });
  await page.getByText("Switch to NanoKVM and update in its settings.").waitFor();
  await page.getByText("No release published yet").waitFor();
  await page.getByText("Not installed").waitFor();
  const managerRow = page.getByRole("row", { name: /Manager/ });
  await managerRow.getByText("Development build", { exact: true }).waitFor();
  await managerRow.getByText("No newer stable release").waitFor();
  const pikvmRow = page.getByRole("row", { name: /PiKVM/ });
  await pikvmRow.getByText("Update to 2.5.1+vim4.20261016.1").waitFor();
  assert.equal(await page.getByRole("button", { name: "Update", exact: true }).count(), 1, "only PiKVM is updated here");
  if (shots) await page.screenshot({ path: `${shots}/updates-desktop.png`, fullPage: true });
  await pikvmRow.getByRole("button", { name: "Update" }).click();
  await page.getByRole("alertdialog").getByText("PiKVM will restart if it is running.").waitFor();
  assert.deepEqual(installs, [], "confirmation precedes installation");
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await pikvmRow.getByRole("button", { name: "Update" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Update" }).click();
  await page.getByText("PiKVM updated to 2.5.1+vim4.20261016.1").waitFor();
  assert.deepEqual(installs, ["vim4-pikvm"]);
  await pikvmRow.getByText("Up to date").waitFor();
  managerLatest = "2.5.1+vim4.20261016.1022";
  await page.getByRole("button", { name: "Check again" }).click();
  await managerRow.getByText("Update to 2.5.1+vim4.20261016.1022").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await managerRow.getByText("Development build", { exact: true }).isVisible(), true, "development badge survives hiding version column on mobile");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, "no horizontal overflow at phone width");
  const clippedActions = await page.getByRole("button", { name: /^Update/ }).evaluateAll(buttons => buttons.filter(button => {
    const bounds = button.getBoundingClientRect();
    for (let parent = button.parentElement; parent; parent = parent.parentElement) {
      if (["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(parent).overflowX)) {
        const clip = parent.getBoundingClientRect();
        if (bounds.left < clip.left - 1 || bounds.right > clip.right + 1) return true;
      }
    }
    return bounds.left < 0 || bounds.right > innerWidth;
  }).map(button => button.textContent));
  assert.deepEqual(clippedActions, [], "mobile update buttons remain fully visible without scrolling sideways");
  if (shots) await page.screenshot({ path: `${shots}/updates-phone.png`, fullPage: true });
  await kernelPanel.getByRole("button", { name: "Switch and restart", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Restart", exact: true }).click();
  await kernelPanel.getByText("The device is restarting. Refresh this page after it starts.").waitFor();
  assert.deepEqual(switches, [{ id: "vendor", reboot: true }]);
  await page.goto(`${process.env.TEST_URL || "http://127.0.0.1:5188"}/#/overview`);
  // The overview now presents the active app's version in its KVM card.
  await page.getByRole("region").filter({ has: page.getByRole("link", { name: /PiKVM/ }) }).getByText("Development build", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, "long development versions wrap in the active component card");
  console.log("PASS: updates, install confirmation, development badges and mobile layout");
} finally {
  await browser.close();
}
