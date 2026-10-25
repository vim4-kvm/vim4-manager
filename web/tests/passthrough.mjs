import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { authenticated } from "./auth-fixture.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.TEST_URL || "http://127.0.0.1:5188";
const shots = process.env.SCREENSHOTS || "/tmp/codex-ui";
const input = { width: 3840, height: 2160, refreshHz: 60, hdr: "SDR", colorFormat: "YCbCr 4:4:4", audio: true };
const monitor = { name: "DELL U2723QE", maxWidth: 3840, maxHeight: 2160, maxRefreshHz: 60, hdr: true, audio: true };
const output = { width: 3840, height: 2160, refreshHz: 60, colorFormat: "YCbCr 4:2:0", scaled: false, hdrToSdr: false };
const status = {
  active: "onekvm", apps: [{ id: "onekvm", name: "One-KVM", port: 8080,
    unit: { name: "vim4-onekvm.service", loaded: true, active: "active", sub: "running", enabled: "enabled" } }], platform: [],
  media: { known: true, inserted: false, connected: false },
  hardware: { hostname: "vim4", kernel: "7.3.0", uptimeSeconds: 60, load1: 0, cpus: 8,
    memTotalKiB: 1024, memAvailableKiB: 512, tempC: 50, zones: [], fanAuto: true,
    fanPercent: 30, usb: "configured", hdrCurve: { white: 203, peak: 1000 } },
  system: { links: [], disk: { totalBytes: 1, freeBytes: 1 }, packages: [] }, events: [], history: [],
};
function fixture(state = "running") {
  return { supported: state !== "unsupported", enabled: !["off", "unsupported"].includes(state), audio: true, state,
    input: ["no-signal", "unsupported"].includes(state) ? undefined : { ...input },
    monitor: ["no-monitor", "unsupported"].includes(state) ? undefined : { ...monitor },
    output: state === "running" ? { ...output } : undefined };
}
const cases = [
  ["unsupported", "当前内核不支持", false, true, "当前内核没有透传功能，可在「更新 → 内核」中切换到支持透传的版本。"],
  ["off", "已关闭", false, false, "开启后显示器显示被控电脑的画面；关闭时显示系统控制台。"],
  ["starting", "正在开启…", true, true],
  ["stopping", "正在关闭…", false, true],
  ["running", "透传中", true, false, "远程 KVM 不受影响。被控电脑切换分辨率时，显示器会短暂黑屏后跟随。"],
  ["no-signal", "等待输入信号", true, false, "HDMI IN 没有信号，显示器保持黑屏，信号恢复后自动继续。"],
  ["no-monitor", "未连接显示器", true, false, "接上显示器后自动开始透传。"],
  ["protected", "输入受版权保护", true, false, "被控电脑正在播放受 HDCP 保护的内容，显示器保持黑屏。"],
  ["unsupported-format", "暂不支持此输入格式", true, false, "此输入格式无法透传，请在信号源中选择 HDR10、HLG 或 SDR。"],
  ["video-error", "输入信号异常", true, false, "请检查 HDMI 输入线或信号源设置。"],
];

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  await mkdir(shots, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await page.clock.install();
  let state = fixture();
  let readError = false;
  let statusError = false;
  let writeError = false;
  let holdWrite;
  let reads = 0;
  const writes = [];
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => route.fulfill({ status: 404, json: { error: "Unexpected test API" } }));
  await page.route("**/api/status", route => {
    const hdmi = state.input ? { signal: true, ...state.input, colorSpace: state.input.colorFormat } : { signal: false, audio: false };
    return route.fulfill(statusError ? { status: 500, json: { error: "offline" } }
      : { json: { ...status, hardware: { ...status.hardware, hdmi } } });
  });
  await page.route("**/api/passthrough", async route => {
    if (route.request().method() === "GET") {
      reads++;
      return route.fulfill(readError ? { status: 500, json: { error: "读取连接中断" } } : { json: state });
    }
    const patch = route.request().postDataJSON();
    writes.push(patch);
    if (holdWrite) await holdWrite;
    if (writeError) return route.fulfill({ status: 500, json: { error: "内核拒绝操作" } });
    state = { ...state, ...patch, state: (patch.enabled ?? state.enabled) ? "running" : "off" };
    return route.fulfill({ json: state });
  });
  await authenticated(page);
  const card = page.getByRole("region", { name: "透传", exact: true });
  const toggle = card.getByRole("switch", { name: "透传", exact: true });
  const audio = card.getByRole("switch", { name: "声音", exact: true });
  const rowStatus = title => card.locator(".wifi-row").filter({ has: page.getByRole("heading", { name: title, exact: true }) }).getByRole("status");
  const fact = label => card.locator(".edid-fact").filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }) });
  const value = label => fact(label).locator("dd").first().textContent();
  const reload = async () => {
    await page.goto(`${base}/#/output`);
    await page.reload();
    await toggle.waitFor();
    await page.locator('.nav-item[href="#/apps"] .nav-hint').getByText("One-KVM", { exact: true }).waitFor({ state: "attached" });
  };
  const poll = async () => {
    const response = page.waitForResponse(r => r.url().endsWith("/api/passthrough") && r.request().method() === "GET");
    await page.clock.runFor(2100);
    await response;
    // Browser rendering settles independently of the mocked timer clock.
    await page.waitForFunction(() => !document.querySelector(".passthrough-card")?.textContent.includes("正在读取透传状态…"));
  };
  const checkLayout = async device => {
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "page must not overflow");
    // Capture all alignment measurements in one frame, including both switch
    // rows and wrapped secondary facts in the scaling/HDR screenshots.
    const layout = await card.evaluate(el => {
      const box = node => node.getBoundingClientRect().toJSON();
      return {
        rows: [...el.querySelectorAll(".wifi-row")].map(row => ({
          title: box(row.querySelector("h3")), control: box(row.querySelector('[role="switch"]')),
          description: box(row.querySelector("p")), width: row.getBoundingClientRect().width,
        })),
        facts: [...el.querySelectorAll(".edid-fact")].map(fact => ({
          box: box(fact), lamp: box(fact.querySelector(".lamp")), value: box(fact.querySelector("dd > span:last-child")),
          detail: fact.querySelector(".passthrough-detail") ? box(fact.querySelector(".passthrough-detail")) : null,
        })),
        paragraphs: [...el.querySelectorAll("p")].map(p => getComputedStyle(p).textWrapStyle),
      };
    });
    for (const row of layout.rows) {
      assert(Math.abs(row.title.y + row.title.height / 2 - row.control.y - row.control.height / 2) < 0.5,
        "each switch aligns vertically with its title");
      assert(row.description.y >= row.control.y + row.control.height, "description sits below its switch");
      assert(row.description.width > row.width - 60, "description spans the card");
    }
    assert(layout.paragraphs.every(style => style === "pretty"), "all explanatory paragraphs use pretty wrapping");
    for (const [index, fact] of layout.facts.entries()) {
      assert(Math.abs(fact.lamp.y + fact.lamp.height / 2 - fact.value.y - fact.value.height / 2) < 0.5,
        "lamp centers vertically beside its primary value");
      if (fact.detail) assert(Math.abs(fact.detail.x - fact.value.x) < 0.5, "secondary value shares the primary text's left edge");
      if (device === "desktop") assert(fact.box.width >= 160 && fact.box.width <= 280, "desktop fact widths stay within content bounds");
      if (index > 0) {
        const previous = layout.facts[index - 1].box;
        if (device === "mobile") assert(Math.abs(fact.box.y - previous.y - previous.height - 16) < 0.5, "mobile facts stack with consistent spacing");
        else {
          assert.equal(fact.box.y, previous.y, "desktop facts share a row");
          assert(Math.abs(fact.box.x - previous.x - previous.width - 48) < 0.5, "desktop columns use a 48px gap");
        }
      }
    }
  };
  await reload();
  assert.deepEqual((await page.locator(".nav-label").allTextContents()).slice(5, 8), ["视频输入", "HDMI 输出", "散热"]);
  assert.equal(await page.locator(".page-head p").textContent(), "板子 HDMI OUT 口接的本地显示器。");
  assert.equal(await value("输入"), "3840×2160 60Hz");
  assert.equal(await value("显示器"), "DELL U2723QE");
  assert.equal(await value("输出"), "3840×2160 60Hz");
  assert.equal(await fact("输入").locator(".muted").textContent(), "SDR · YCbCr 4:4:4");
  assert.equal(await fact("显示器").locator(".muted").textContent(), "最高 3840×2160 60Hz · HDR");
  assert.equal(await fact("输出").locator(".muted").textContent(), "YCbCr 4:2:0");

  // All specified states, plus scaling and HDR conversion, in both themes
  // and viewports. Each state starts with a fresh route read.
  const desktopTypography = new Map();
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    for (const [device, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
      await page.setViewportSize({ width, height });
      for (const [name, label, checked, disabled, description] of cases) {
        state = fixture(name);
        await reload();
        assert.equal(await rowStatus("透传").textContent(), label);
        assert.equal(await toggle.getAttribute("aria-checked"), String(checked));
        assert.equal(await toggle.isDisabled(), disabled);
        const transitioning = ["starting", "stopping"].includes(name);
        const spinner = rowStatus("透传").locator(".spinner");
        assert.equal(await spinner.count(), transitioning ? 1 : 0);
        if (transitioning) {
          assert(await spinner.isVisible());
          const ring = await spinner.evaluate(el => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return { width: rect.width, height: rect.height, border: parseFloat(style.borderTopWidth),
              topColor: style.borderTopColor, trackColor: style.borderRightColor, radius: style.borderRadius,
              animation: style.animationName };
          });
          assert(ring.width >= 12 && ring.height >= 12 && Math.abs(ring.width - ring.height) < 0.1,
            `${device}/${theme}/${name}: spinner must render as a circle, not an inline stroke: ${JSON.stringify(ring)}`);
          assert(ring.border > 0);
          assert.equal(ring.radius, "50%");
          assert.notEqual(ring.topColor, ring.trackColor, "spinner arc is distinguishable in both themes");
          assert.equal(ring.animation, "spin");
          assert.equal(await value("输出"), "切换中…");
          assert.equal(await fact("输出").locator(".status-idle").count(), 1);
          assert.equal(await fact("输出").locator(".muted").count(), 0);
          assert.equal(await rowStatus("声音").textContent(), name === "starting" ? "透传开启后生效" : "已关闭");
        }
        if (description) assert.equal(await card.locator(".passthrough-description").textContent(), description);
        assert.equal(await audio.count(), name === "unsupported" ? 0 : 1);
        if (name !== "unsupported") {
          const strength = await audio.evaluate(el => {
            const style = getComputedStyle(el);
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = style.backgroundColor;
            ctx.fillRect(0, 0, 1, 1);
            return ctx.getImageData(0, 0, 1, 1).data[3] / 255 * Number(style.opacity);
          });
          assert.equal(await audio.getAttribute("aria-checked"), "true", "saved audio remains on");
          if (name === "running") assert.equal(strength, 1, "effective audio uses the full accent");
          else assert(strength > 0 && strength < 0.6, "inactive audio uses a subdued accent in either theme");
          if (["off", "no-monitor"].includes(name)) assert(await audio.isEnabled(), "inactive audio preference stays editable");
        }
        const hint = page.locator('.nav-item[href="#/output"] .nav-hint');
        const hintText = { running: "透传", "no-signal": "等待信号", protected: "受保护" }[name];
        assert.equal(await hint.count(), hintText ? 1 : 0);
        if (hintText) {
          assert.equal(await hint.textContent(), hintText);
          assert.match(await hint.getAttribute("class"), name === "running" ? /status-good/ : /status-warning/);
        }
        if (name === "off") assert.equal(await value("输出"), "系统控制台");
        if (["no-signal", "protected"].includes(name)) assert.equal(await value("输出"), "黑屏");
        if (name === "no-signal") assert.equal(await value("输入"), "无信号");
        if (name === "no-monitor") assert.equal(await value("显示器"), "未连接");
        if (name === "unsupported") {
          assert.equal(await card.locator("dl, .edid-fact").count(), 0, "unsupported hides the entire fact area");
          assert.equal(await card.locator(".passthrough-body").textContent(), cases[0][4]);
          assert.equal(await card.getByRole("link", { name: "更新 → 内核" }).getAttribute("href"), "#/updates");
          assert.equal(await page.locator(".sidebar-foot > .mono").textContent(), "7.3.0");
        }
        assert.equal(await page.locator('.nav-item[href="#/media"] .nav-hint').count(), 0, "normal empty media adds no unrelated warning");
        assert.equal(await page.locator('.nav-item[href="#/video"] .nav-hint').textContent(),
          state.input ? `${state.input.height}p` : "无信号", "overview HDMI fixture matches passthrough input");
        const typography = await card.locator(".edid-fact dd:not(.muted)").evaluateAll(elements => elements.map(el => {
          const style = getComputedStyle(el);
          return { size: style.fontSize, weight: style.fontWeight };
        }));
        if (device === "desktop") desktopTypography.set(`${theme}/${name}`, typography);
        else assert.deepEqual(typography, desktopTypography.get(`${theme}/${name}`), "mobile fact typography matches desktop");
        await checkLayout(device);
        await page.screenshot({ path: `${shots}/passthrough-${device}-${theme}-${name}.png`, fullPage: true });
      }
      for (const kind of ["scaled", "hdr-sdr"]) {
        state = fixture();
        if (kind === "scaled") {
          state.output = { ...output, width: 1920, height: 1080, refreshHz: 59.94, scaled: true };
          state.input.refreshHz = 23.976;
        } else {
          state.input.hdr = "HDR10";
          state.monitor.hdr = false;
          state.output.hdrToSdr = true;
        }
        await reload();
        if (kind === "scaled") {
          assert.equal(await value("输出"), "1920×1080 59.94Hz");
          assert.equal(await value("输入"), "3840×2160 23.98Hz");
          assert.equal(await fact("输出").locator(".muted").textContent(), "已缩放，显示器不支持 3840×2160 23.98Hz");
          assert.equal(await fact("输出").locator(".status-warning").count(), 1);
        } else {
          assert.equal(await fact("输出").locator(".muted").textContent(), "HDR 已转为 SDR");
        }
        await checkLayout(device);
        await page.screenshot({ path: `${shots}/passthrough-${device}-${theme}-${kind}.png`, fullPage: true });
      }
    }
  }

  state = fixture();
  state.monitor.name = "";
  state.input.hdr = "HLG";
  await reload();
  assert.equal(await value("显示器"), "未知型号");
  assert.equal(await fact("输入").locator(".muted").textContent(), "HLG · YCbCr 4:4:4");
  state.output.scaled = true;
  state.output.hdrToSdr = true;
  state.monitor.hdr = false;
  await reload();
  assert.match(await fact("输出").locator(".muted").textContent(), /已缩放，显示器不支持 .* · HDR 已转为 SDR/);
  state = fixture();
  delete state.output;
  await reload();
  assert.equal(await value("输出"), "—", "missing output metadata must not claim a system console");

  for (const [name, edit, label, disabled] of [
    ["off", s => { s.audio = false; s.monitor.audio = false; }, "透传开启后生效", false],
    ["running", () => {}, "输出中", false],
    ["running", s => { s.input.audio = false; }, "输入无声音", false],
    ["running", s => { s.monitor.audio = false; }, "显示器不支持音频", true],
    ["running", s => { s.audio = false; }, "已关闭", false],
    ["running", s => { s.audioState = "starting"; }, "正在连接声音…", false],
    ["running", s => { s.audioState = "error"; }, "声音暂不可用", false],
    ["running", s => { s.audioState = "running"; }, "输出中", false],
    ["unsupported-format", s => { s.audioState = "running"; s.input.hdr = "Dolby Vision"; }, "输出中", false],
    ["video-error", s => { s.audioState = "running"; }, "输出中", false],
  ]) {
    state = fixture(name);
    edit(state);
    await reload();
    assert.equal(await rowStatus("声音").textContent(), label);
    assert.equal(await audio.isDisabled(), disabled);
  }
  state = fixture("unsupported-format");
  state.reason = "Dolby Vision 信号无法透传，请在信号源中选择 HDR10、HLG 或 SDR。";
  await reload();
  assert.equal(await card.locator(".passthrough-description").textContent(), state.reason);
  assert.equal(await value("输出"), "—");
  // Changing audio while off saves the preference immediately, without a dialog.
  state = fixture("off");
  state.audio = false;
  await reload();
  await audio.click();
  await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="声音"]').getAttribute("aria-checked") === "true");
  assert.deepEqual(writes.at(-1), { audio: true });
  assert.equal(await page.getByRole("dialog").count(), 0);

  // Failed enable and disable return to freshly read actual backend state.
  for (const [name, verb, checked] of [["off", "开启", false], ["running", "关闭", true]]) {
    state = fixture(name);
    await reload();
    writeError = true;
    await toggle.click();
    await page.locator(".banner-critical").getByText(`${verb}透传失败：内核拒绝操作`, { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="透传"][role="switch"]').disabled);
    assert.equal(await toggle.getAttribute("aria-checked"), String(checked));
    writeError = false;
  }

  // Optimistic switch and retained explanation during a pending request;
  // the global busy lock pauses page polling until the write completes.
  state = fixture("off");
  await reload();
  let release;
  holdWrite = new Promise(resolve => { release = resolve; });
  await toggle.click();
  await rowStatus("透传").getByText("正在开启…", { exact: true }).waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  assert(await toggle.isDisabled());
  assert(await audio.isDisabled());
  assert.equal(await value("输出"), "切换中…");
  assert.equal(await fact("输出").locator(".status-idle").count(), 1);
  assert.equal(await rowStatus("声音").textContent(), "透传开启后生效");
  const beforeBusy = reads;
  await page.clock.runFor(6000);
  assert.equal(reads, beforeBusy, "busy pauses passthrough polling");
  assert.equal(await card.locator(".passthrough-description").textContent(), cases[1][4]);
  release();
  holdWrite = undefined;
  await rowStatus("透传").getByText("透传中", { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="透传"][role="switch"]').disabled);
  state.state = "stopping";
  await poll();
  await rowStatus("透传").getByText("正在关闭…", { exact: true }).waitFor();
  assert.equal(await value("输出"), "切换中…");
  assert.equal(await fact("输出").locator(".status-idle").count(), 1);
  assert.equal(await rowStatus("声音").textContent(), "已关闭");
  assert.equal(await card.locator(".passthrough-description").textContent(), cases[4][4]);
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  state = fixture();
  await poll();
  await rowStatus("透传").getByText("透传中", { exact: true }).waitFor();

  // A read error preserves facts but disables controls; recovery unlocks them.
  readError = true;
  await poll();
  await card.getByRole("alert").getByText("刷新失败：读取连接中断，显示的是上次读取的状态。", { exact: true }).waitFor();
  assert(await toggle.isDisabled());
  assert(await audio.isDisabled());
  assert.equal(await value("显示器"), "DELL U2723QE");
  readError = false;
  await poll();
  await page.waitForFunction(() => !document.querySelector('[aria-label="透传"][role="switch"]').disabled);
  statusError = true;
  await page.clock.runFor(3100);
  await page.getByText("连接中断", { exact: true }).waitFor({ state: "attached" });
  assert(await toggle.isDisabled(), "global stale disables the switch despite a successful page read");
  assert(await audio.isDisabled());
  statusError = false;

  // The global status supplies navigation hints while this page is unmounted.
  status.passthrough = fixture("protected");
  await page.getByRole("link", { name: "视频输入", exact: false }).click();
  const beforeLeave = reads;
  await page.clock.runFor(6000);
  assert.equal(reads, beforeLeave, "leaving output stops GET polling");
  await page.waitForFunction(() => document.querySelector('.nav-item[href="#/output"] .nav-hint')?.textContent === "受保护");
  assert.equal(await page.locator('.nav-item[href="#/output"] .nav-hint').textContent(), "受保护");
  delete status.passthrough;

  readError = true;
  await page.goto(`${base}/#/output`);
  await card.getByRole("alert").getByText("读取失败：读取连接中断", { exact: true }).waitFor();
  assert.equal(await card.locator("dl").count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: passthrough states, facts, HDR/scaling, audio, failures, stale, busy/poll lifecycle; 48 screenshots");
} finally {
  await browser.close();
}
