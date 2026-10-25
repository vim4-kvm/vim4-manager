import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const shots = process.env.SCREENSHOTS;
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  const development = "2.5.1+vim4.20261016.1020.dev.9.g49c45f2.dirty";
  let managerLatest = "2.5.1+vim4.20261016.1020";
  const unit = { name: "vim4-pikvm.service", loaded: true, active: "active", sub: "running", enabled: "enabled" };
  const status = {
    active: "pikvm", apps: [{ id: "pikvm", name: "PiKVM", unit, description: "", port: 8080 }], platform: [],
    hardware: { hostname: "vim4", kernel: "5.15.137", uptimeSeconds: 60, load1: 0, cpus: 8, memTotalKiB: 1, memAvailableKiB: 1,
      tempC: 50, zones: [], fanAuto: true, fanPercent: 30, usb: "configured", hdmi: { signal: true, height: 1080, audio: true },
      hdrCurve: { white: 203, peak: 1000 } },
    system: { links: [], disk: { totalBytes: 1, freeBytes: 1 }, packages: [{ name: "vim4-manager", version: development }] }, history: [], events: [],
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
      { package: "vim4-onekvm", name: "One-KVM", repo: "One-KVM", installed: "2.5.1+vim4.20261015.62", available: false, selfService: true, error: "尚未发布" },
      { package: "vim4-pikvm", name: "PiKVM", repo: "kvmd", installed: pikvm, latest, available: pikvm !== latest, selfService: false },
      { package: "vim4-manager", name: "管理面板", repo: "vim4-manager", installed: development, latest: managerLatest,
        available: managerLatest !== "2.5.1+vim4.20261016.1020", selfService: false },
    ] });
  });
  await (await import("./auth-fixture.mjs")).authenticated(page);
  await page.goto(`${process.env.TEST_URL || "http://127.0.0.1:5188"}/#/updates`);
  await page.getByRole("heading", { name: "更新", exact: true }).waitFor();
  const kernelPanel = page.getByRole("region", { name: "内核", exact: true });
  await kernelPanel.getByText("正在运行", { exact: true }).waitFor();
  await kernelPanel.getByText("正式版", { exact: true }).waitFor();
  await kernelPanel.getByRole("button", { name: "重启此内核", exact: true }).waitFor();
  kernelRelease = "7.3.0-rc7-vim4kvm-uhd1+";
  await page.reload();
  await kernelPanel.getByText(kernelRelease, { exact: true }).last().waitFor();
  assert.equal(await kernelPanel.getByText("正式版", { exact: true }).count(), 0);
  kernelRelease = "7.3.0-vim4kvm-uhd1+";
  await page.reload();
  await kernelPanel.getByText("正式版", { exact: true }).waitFor();
  await kernelPanel.getByRole("button", { name: "切换并重启", exact: true }).click();
  await page.getByRole("alertdialog").waitFor();
  assert.deepEqual(switches, [], "choosing a kernel cannot immediately reboot");
  await page.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("alertdialog").waitFor({ state: "hidden" });
  await page.getByText("切换到 NanoKVM 后在其设置中更新").waitFor();
  await page.getByText("尚未发布").waitFor();
  await page.getByText("未安装").waitFor();
  const managerRow = page.getByRole("row", { name: /管理面板/ });
  await managerRow.getByText("开发版", { exact: true }).waitFor();
  await managerRow.getByText("暂无更新的正式版").waitFor();
  const pikvmRow = page.getByRole("row", { name: /PiKVM/ });
  await pikvmRow.getByText("可更新到 2.5.1+vim4.20261016.1").waitFor();
  assert.equal(await page.getByRole("button", { name: "更新", exact: true }).count(), 1, "only PiKVM is updated here");
  if (shots) await page.screenshot({ path: `${shots}/updates-desktop.png`, fullPage: true });
  await pikvmRow.getByRole("button", { name: "更新" }).click();
  await page.getByRole("alertdialog").getByText("PiKVM 运行中会重启。").waitFor();
  assert.deepEqual(installs, [], "confirmation precedes installation");
  await page.getByRole("alertdialog").getByRole("button", { name: "取消" }).click();
  await pikvmRow.getByRole("button", { name: "更新" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "更新" }).click();
  await page.getByText("PiKVM 已更新到 2.5.1+vim4.20261016.1").waitFor();
  assert.deepEqual(installs, ["vim4-pikvm"]);
  await pikvmRow.getByText("已是最新").waitFor();
  managerLatest = "2.5.1+vim4.20261016.1022";
  await page.getByRole("button", { name: "重新检查" }).click();
  await managerRow.getByText("可更新到 2.5.1+vim4.20261016.1022").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await managerRow.getByText("开发版", { exact: true }).isVisible(), true, "development badge survives hiding version column on mobile");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, "no horizontal overflow at phone width");
  if (shots) await page.screenshot({ path: `${shots}/updates-phone.png`, fullPage: true });
  await kernelPanel.getByRole("button", { name: "切换并重启", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "确认重启", exact: true }).click();
  await kernelPanel.getByText("设备正在重启，启动完成后请刷新此页面。").waitFor();
  assert.deepEqual(switches, [{ id: "vendor", reboot: true }]);
  await page.goto(`${process.env.TEST_URL || "http://127.0.0.1:5188"}/#/overview`);
  await page.getByRole("button", { name: "查看各组件" }).click();
  await page.getByRole("region", { name: "存储与版本" }).getByRole("listitem").getByText("开发版", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, "long development versions wrap in component list");
  console.log("PASS: updates, install confirmation, development badges and mobile layout");
} finally {
  await browser.close();
}
