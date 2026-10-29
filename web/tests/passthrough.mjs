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
  return { supported: state !== "unsupported", enabled: !["off", "unsupported"].includes(state), audio: true, hdr: true, state,
    input: ["no-signal", "unsupported"].includes(state) ? undefined : { ...input },
    monitor: ["no-monitor", "unsupported"].includes(state) ? undefined : { ...monitor },
    output: state === "running" ? { ...output } : undefined };
}
const cases = [
  ["unsupported", "Unavailable on this kernel", false, true, "This kernel has no passthrough support. Choose a supported kernel. Updates → Kernel"],
  ["off", "Off", false, false, "When on, the display shows the target computer. When off, it shows the system console."],
  ["starting", "Turning on…", true, true],
  ["stopping", "Turning off…", false, true],
  ["running", "Passthrough active", true, false, "Remote KVM stays connected. The local display may briefly go blank when the target computer changes resolution."],
  ["no-signal", "Waiting for input", true, false, "No HDMI IN signal. The display stays black and resumes automatically when the signal returns."],
  ["no-monitor", "No display connected", true, false, "Passthrough starts automatically when a display connects."],
  ["protected", "Protected input", true, false, "The target computer is playing HDCP-protected content. The display stays black."],
  ["unsupported-format", "Unsupported input format", true, false, "This format cannot pass through. Select HDR10, HLG, or SDR on the source."],
  ["video-error", "Input signal problem", true, false, "Check the HDMI input cable and source settings."],
];

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  await mkdir(shots, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await (await import("./auth-fixture.mjs")).pinLanguage(page);
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
      return route.fulfill(readError ? { status: 500, json: { error: "Read connection lost" } } : { json: state });
    }
    const patch = route.request().postDataJSON();
    writes.push(patch);
    if (holdWrite) await holdWrite;
    if (writeError) return route.fulfill({ status: 500, json: { error: typeof writeError === "string" ? writeError : "Kernel refused the action" } });
    state = { ...state, ...patch, state: (patch.enabled ?? state.enabled) ? "running" : "off" };
    return route.fulfill({ json: state });
  });
  await authenticated(page);
  const card = page.getByRole("region", { name: "Passthrough", exact: true });
  const toggle = card.getByRole("switch", { name: "Passthrough", exact: true });
  const audio = card.getByRole("switch", { name: "Sound", exact: true });
  const hdr = card.getByRole("switch", { name: "HDR", exact: true });
  const row = title => card.getByRole("group", { name: title, exact: true });
  const rowStatus = title => row(title).getByRole("status");
  const toasts = page.getByRole("region", { name: /Notifications/ });
  const navHint = id => page.locator(`[data-nav-hint="${id}"]`);
  const fact = label => card.locator("div:has(> dt)").filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }) });
  const detail = label => fact(label).locator("dd[title]");
  const value = label => fact(label).locator("dd").first().textContent();
  const reload = async () => {
    await page.goto(`${base}/#/output`);
    const statusLoaded = page.waitForResponse(r => r.url().endsWith("/api/status") && r.ok());
    await page.reload();
    await toggle.waitFor();
    await statusLoaded;
  };
  const poll = async () => {
    const response = page.waitForResponse(r => r.url().endsWith("/api/passthrough") && r.request().method() === "GET");
    await page.clock.runFor(2100);
    await response;
    // Browser rendering settles independently of the mocked timer clock.
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  };
  const checkLayout = async device => {
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "page must not overflow");
    // Capture all alignment measurements in one frame, including every switch
    // row and wrapped secondary facts in the scaling/HDR screenshots.
    const layout = await card.evaluate(el => {
      const box = node => node.getBoundingClientRect().toJSON();
      return {
        rows: [...el.querySelectorAll('[role="group"]')].map(row => ({
          row: box(row), title: box(row.querySelector("h3")), control: box(row.querySelector('[role="switch"]')),
          description: box(row.querySelector("p")),
        })),
        facts: [...el.querySelectorAll("div:has(> dt)")].filter(fact => fact.querySelector("[data-tone]")).map(fact => ({
          box: box(fact), lamp: box(fact.querySelector("[data-tone]")), value: box(fact.querySelector("dd > span > span:last-child")),
          detail: fact.querySelector("dd[title]") ? box(fact.querySelector("dd[title]")) : null,
        })),
        paragraphs: [...el.querySelectorAll("[data-description], [role=group] > p")].map(p => getComputedStyle(p).textWrapStyle),
      };
    });
    assert(layout.rows.every(row => Math.abs(row.control.right - row.row.right) < 1), "each card keeps its switches right aligned");
    for (const row of layout.rows) {
      assert(row.control.width > 0 && row.description.y >= row.title.y + row.title.height, "description sits below its title");
      if (row.row.width < 448) {
        assert(row.control.y >= row.description.bottom,
          "phone controls follow the full-width title and description");
        assert(row.description.width > row.row.width - 60, "phone descriptions span the row");
      } else {
        assert(Math.abs(row.row.y + row.row.height / 2 - row.control.y - row.control.height / 2) < 1,
          "desktop switches center on their row");
        assert(row.description.right < row.control.left, "desktop descriptions stay left of the control column");
      }
    }
    assert(layout.paragraphs.every(style => style === "pretty"), "all explanatory paragraphs use pretty wrapping");
    for (const [index, fact] of layout.facts.entries()) {
      assert(Math.abs(fact.lamp.y + fact.lamp.height / 2 - fact.value.y - fact.value.height / 2) < 1,
        "lamp centers vertically beside its primary value");
      if (fact.detail) assert(Math.abs(fact.detail.x - fact.value.x) < 0.5, "secondary value shares the primary text's left edge");
      if (device === "desktop") assert(fact.box.width >= 160 && fact.box.width <= 400, "desktop fact widths stay within content bounds");
      if (index > 0) {
        const previous = layout.facts[index - 1].box;
        if (device === "mobile") assert(Math.abs(fact.box.y - previous.y - previous.height - 16) < 0.5, "mobile facts stack with consistent spacing");
        else {
          assert.equal(fact.box.y, previous.y, "desktop facts share a row");
          assert(Math.abs(fact.box.x - previous.x - previous.width - 32) < 0.5, "desktop columns use a 32px gap");
        }
      }
    }
  };
  await reload();
  const navTitles = await page.getByRole("navigation", { name: "Pages" }).getByRole("link")
    .evaluateAll(links => links.map(link => link.querySelector("span").textContent));
  assert.deepEqual(navTitles.slice(5, 8), ["Video input", "HDMI output", "Cooling"]);
  assert.equal(await page.locator("#page-title + p").textContent(), "Manage the local display connected to HDMI OUT.");
  assert.equal(await value("Input"), "3840×2160 60 Hz");
  assert.equal(await value("Display"), "DELL U2723QE");
  assert.equal(await value("Output"), "3840×2160 60 Hz");
  assert.equal(await detail("Input").textContent(), "SDR · YCbCr 4:4:4");
  assert.equal(await detail("Display").textContent(), "Up to 3840×2160 60 Hz · HDR");
  assert.equal(await detail("Output").textContent(), "YCbCr 4:2:0");

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
        assert.equal(await rowStatus("Passthrough").textContent(), label);
        assert.equal(await toggle.getAttribute("aria-checked"), String(checked));
        assert.equal(await toggle.isDisabled(), disabled);
        const transitioning = ["starting", "stopping"].includes(name);
        const spinner = rowStatus("Passthrough").locator("svg");
        assert.equal(await spinner.count(), transitioning ? 1 : 0);
        if (transitioning) {
          assert(await spinner.isVisible());
          const ring = await spinner.evaluate(el => {
            const rect = el.getBoundingClientRect();
            return { width: rect.width, height: rect.height, animation: getComputedStyle(el).animationName };
          });
          assert(ring.width >= 12 && Math.abs(ring.width - ring.height) < 0.1,
            `${device}/${theme}/${name}: spinner must render as a square icon: ${JSON.stringify(ring)}`);
          assert.equal(ring.animation, "none", "reduced motion keeps the pending indicator static");
          assert.equal(await value("Output"), "Switching…");
          assert.equal(await fact("Output").locator("[data-tone=idle]").count(), 1);
          assert.equal(await detail("Output").count(), 0);
          assert.equal(await rowStatus("Sound").textContent(), name === "starting" ? "Applies when passthrough starts" : "Off");
        }
        if (description) assert.equal(await card.locator("[data-description]").textContent(), description);
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
          else {
            assert(strength > 0, "inactive preference stays visible");
            assert.equal(await row("Sound").getAttribute("data-inactive"), "true");
          }
          if (["off", "no-monitor"].includes(name)) assert(await audio.isEnabled(), "inactive audio preference stays editable");
        }
        // Phone navigation lives in the closed menu sheet.
        const hint = navHint("output");
        const hintText = { running: "Passthrough", "no-signal": "Waiting for signal", protected: "Protected" }[name];
        if (device === "desktop") assert.equal(await hint.count(), hintText ? 1 : 0);
        if (hintText && device === "desktop") {
          assert.equal(await hint.textContent(), hintText);
          assert.equal(await hint.getAttribute("data-tone"), name === "running" ? "good" : "warning");
        }
        if (name === "off") assert.equal(await value("Output"), "System console");
        if (["no-signal", "protected"].includes(name)) assert.equal(await value("Output"), "Black screen");
        if (name === "no-signal") assert.equal(await value("Input"), "No signal");
        if (name === "no-monitor") assert.equal(await value("Display"), "Not connected");
        if (name === "unsupported") {
          assert.equal(await card.locator("dl, dt").count(), 0, "unsupported hides the entire fact area");
          assert.equal(await card.locator("[data-passthrough-body]").textContent(), cases[0][4]);
          assert.equal(await card.getByRole("link", { name: "Updates → Kernel" }).getAttribute("href"), "#/updates");
          if (device === "desktop") assert.equal(await page.locator("[data-kernel]").textContent(), "7.3.0");
        }
        if (device === "desktop") {
          assert.equal(await navHint("media").count(), 0, "normal empty media adds no unrelated warning");
          assert.equal(await navHint("video").textContent(),
            state.input ? `${state.input.height}p` : "No signal", "overview HDMI fixture matches passthrough input");
        }
        const typography = await card.locator("div:has(> dt) > dd:not([title])").evaluateAll(elements => elements.map(el => {
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
          assert.equal(await value("Output"), "1920×1080 59.94 Hz");
          assert.equal(await value("Input"), "3840×2160 23.98 Hz");
          assert.equal(await detail("Output").textContent(), "Scaled; the display doesn't support 3840×2160 23.98 Hz");
          assert.equal(await fact("Output").locator("[data-tone=warning]").count(), 1);
        } else {
          assert.match(await detail("Output").textContent(), /^\S.* · Converted to SDR · Display has no HDR support$/);
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
  assert.equal(await value("Display"), "Unknown model");
  assert.equal(await detail("Input").textContent(), "HLG · YCbCr 4:4:4");
  state.output.scaled = true;
  state.output.hdrToSdr = true;
  state.monitor.hdr = false;
  await reload();
  assert.match(await detail("Output").textContent(), /Scaled; the display doesn't support .* · Converted to SDR/);
  state = fixture();
  delete state.output;
  await reload();
  assert.equal(await value("Output"), "—", "missing output metadata must not claim a system console");

  for (const [name, edit, label, disabled] of [
    ["off", s => { s.audio = false; s.monitor.audio = false; }, "Applies when passthrough starts", false],
    ["running", () => {}, "Output active", false],
    ["running", s => { s.input.audio = false; }, "No input audio", false],
    ["running", s => { s.monitor.audio = false; }, "Display has no audio support", true],
    ["running", s => { s.audio = false; }, "Off", false],
    ["running", s => { s.audioState = "starting"; }, "Connecting audio…", false],
    ["running", s => { s.audioState = "error"; }, "Audio unavailable", false],
    ["running", s => { s.audioState = "running"; }, "Output active", false],
    ["unsupported-format", s => { s.audioState = "running"; s.input.hdr = "Dolby Vision"; }, "Output active", false],
    ["video-error", s => { s.audioState = "running"; }, "Output active", false],
  ]) {
    state = fixture(name);
    edit(state);
    await reload();
    assert.equal(await rowStatus("Sound").textContent(), label);
    assert.equal(await audio.isDisabled(), disabled);
  }
  state = fixture("unsupported-format");
  state.reason = "Dolby Vision cannot pass through. Select HDR10, HLG, or SDR on the target computer.";
  await reload();
  assert.equal(await card.locator("[data-description]").textContent(), state.reason);
  assert.equal(await value("Output"), "—");
  // Changing audio while off saves the preference immediately, without a dialog.
  state = fixture("off");
  state.audio = false;
  await reload();
  await audio.click();
  await page.waitForFunction(() => document.querySelector("[role=\"switch\"][aria-label=\"Sound\"]").getAttribute("aria-checked") === "true");
  assert.deepEqual(writes.at(-1), { audio: true });
  assert.equal(await page.getByRole("dialog").count(), 0);

  // Failed enable and disable return to freshly read actual backend state.
  for (const [name, verb, checked] of [["off", "enable passthrough", false], ["running", "disable passthrough", true]]) {
    state = fixture(name);
    await reload();
    writeError = true;
    await toggle.click();
    await toasts.getByText(`Couldn't ${verb}. Kernel refused the action`, { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector("[aria-label=\"Passthrough\"][role=\"switch\"]").disabled);
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
  await rowStatus("Passthrough").getByText("Turning on…", { exact: true }).waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  assert(await toggle.isDisabled());
  assert(await audio.isDisabled());
  assert.equal(await value("Output"), "Switching…");
  assert.equal(await fact("Output").locator("[data-tone=idle]").count(), 1);
  assert.equal(await rowStatus("Sound").textContent(), "Applies when passthrough starts");
  const beforeBusy = reads;
  await page.clock.runFor(6000);
  assert.equal(reads, beforeBusy, "busy pauses passthrough polling");
  assert.equal(await card.locator("[data-description]").textContent(), cases[1][4]);
  release();
  holdWrite = undefined;
  await rowStatus("Passthrough").getByText("Passthrough active", { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector("[aria-label=\"Passthrough\"][role=\"switch\"]").disabled);
  state.state = "stopping";
  await poll();
  await rowStatus("Passthrough").getByText("Turning off…", { exact: true }).waitFor();
  assert.equal(await value("Output"), "Switching…");
  assert.equal(await fact("Output").locator("[data-tone=idle]").count(), 1);
  assert.equal(await rowStatus("Sound").textContent(), "Off");
  assert.equal(await card.locator("[data-description]").textContent(), cases[4][4]);
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  state = fixture();
  await poll();
  await rowStatus("Passthrough").getByText("Passthrough active", { exact: true }).waitFor();

  // A read error preserves facts but disables controls; recovery unlocks them.
  readError = true;
  await poll();
  await card.getByRole("alert").getByText("Couldn't refresh: Read connection lost. Showing the last known state.", { exact: true }).waitFor();
  assert(await toggle.isDisabled());
  assert(await audio.isDisabled());
  assert.equal(await value("Display"), "DELL U2723QE");
  readError = false;
  await poll();
  await page.waitForFunction(() => !document.querySelector("[aria-label=\"Passthrough\"][role=\"switch\"]").disabled);
  // The connection state and navigation live in the desktop sidebar.
  await page.setViewportSize({ width: 1440, height: 900 });
  statusError = true;
  await page.clock.runFor(3100);
  await page.getByText("Connection lost", { exact: true }).waitFor({ state: "attached" });
  assert(await toggle.isDisabled(), "global stale disables the switch despite a successful page read");
  assert(await audio.isDisabled());
  statusError = false;

  // The global status supplies navigation hints while this page is unmounted.
  status.passthrough = fixture("protected");
  await page.getByRole("link", { name: "Video input", exact: false }).click();
  const beforeLeave = reads;
  await page.clock.runFor(6000);
  assert.equal(reads, beforeLeave, "leaving output stops GET polling");
  await page.waitForFunction(() => document.querySelector('[data-nav-hint="output"]')?.textContent === "Protected");
  assert.equal(await navHint("output").textContent(), "Protected");
  delete status.passthrough;

  for (const [device, width, height] of [["desktop", 1440, 1100], ["mobile", 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: "light" });
    for (const [name, current, edit, label, checked, disabled, inactive] of [
      ["hdr-output", "running", () => {}, "HDR output active", true, false, false],
      ["hdr-to-sdr", "running", next => { next.hdr = false; next.output.hdrToSdr = true; }, "Converted to SDR", false, false, false],
      ["hdr-starting", "starting", () => {}, "Applies when passthrough starts", true, true, true],
      ["hdr-stopping", "stopping", () => {}, "Off", true, true, true],
      ["hdr-preset", "off", () => {}, "Applies when passthrough starts", true, false, true],
      ["hdr-no-support", "running", next => { next.monitor.hdr = false; next.output.hdrToSdr = true; }, "Display has no HDR support", true, true, true],
      ["hdr-no-input", "no-signal", () => {}, "Waiting for input", true, false, true],
      ["hdr-sdr-input", "running", next => { next.input.hdr = "SDR"; }, "SDR input", true, false, true],
      ["hdr-applying", "video-error", () => {}, "Applying…", true, false, false],
    ]) {
      state = fixture(current);
      if (state.input) state.input.hdr = "HDR10";
      edit(state);
      await reload();
      assert.equal(await rowStatus("HDR").textContent(), label);
      assert.equal(await hdr.getAttribute("aria-checked"), String(checked));
      assert.equal(await hdr.isDisabled(), disabled);
      assert.equal(await row("HDR").getAttribute("data-inactive") === "true", inactive);
      await checkLayout(device);
      assert(await hdr.evaluate(element => element.getBoundingClientRect().width === 32), "switch must not shrink");
      if (name === "hdr-no-support") assert.match(await fact("Output").textContent(), /Converted to SDR · Display has no HDR support/);
      if (name === "hdr-output") assert.match(await fact("Output").textContent(), /HDR10 · BT.2020/);
      if (name === "hdr-to-sdr") assert.match(await detail("Output").textContent(), /^\S.* · Converted to SDR$/);
      if (["hdr-output", "hdr-to-sdr", "hdr-preset", "hdr-no-support", "hdr-sdr-input"].includes(name)) {
        await page.screenshot({ path: `${shots}/${name}-${device}.png`, fullPage: true });
      }
    }
    state = fixture();
    state.input.hdr = "HLG";
    await reload();
    assert.match(await fact("Output").textContent(), /HLG · BT.2020/);
    holdWrite = new Promise(resolve => { release = resolve; });
    await hdr.click();
    await rowStatus("HDR").getByText("Switching…", { exact: true }).waitFor();
    assert.equal(await hdr.getAttribute("aria-checked"), "false");
    assert(await hdr.isDisabled());
    assert(await toggle.isDisabled());
    assert(await audio.isDisabled());
    assert.equal(await rowStatus("HDR").locator("svg").count(), 1);
    assert.equal(await row("HDR").getAttribute("data-inactive"), null);
    await page.screenshot({ path: `${shots}/hdr-pending-${device}.png`, fullPage: true });
    release();
    holdWrite = undefined;
    await page.waitForFunction(() => !document.querySelector('[role="switch"][aria-label="HDR"]').disabled);
    assert.deepEqual(writes.at(-1), { hdr: false });
    for (const failure of ["sudo: /usr/libexec/failure.py Traceback: PermissionError", "Couldn't apply HDR settings. Try again."]) {
      writeError = failure;
      await hdr.click();
      await toasts.getByText("Couldn't save HDR settings. Couldn't apply HDR settings. Try again.", { exact: true }).waitFor();
      assert.doesNotMatch(await toasts.textContent(), /sudo:|\/usr\/|Traceback|PermissionError/);
      await page.waitForFunction(() => !document.querySelector('[role="switch"][aria-label="HDR"]').disabled);
    }
    await page.screenshot({ path: `${shots}/hdr-failure-${device}.png`, fullPage: true });
    writeError = false;
  }

  readError = true;
  await page.goto(`${base}/#/output`);
  await page.reload();
  await card.getByRole("alert").getByText("Couldn't load settings: Read connection lost", { exact: true }).waitFor();
  assert.equal(await card.locator("dl").count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: passthrough states, HDR preference table, safe errors, facts, audio, stale, busy/poll lifecycle; 62 screenshots");
} finally {
  await browser.close();
}
