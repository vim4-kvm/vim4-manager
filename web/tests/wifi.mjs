import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const hotspotDefaults = {
  configured: true,
  active: false,
  ssid: "VIM4-KVM-BC28",
  password: "k7mpq4xr2wzt",
  channel: 0,
  autostart: false,
  address: "10.42.0.1/24",
  clients: [],
};
const home = { id: "11111111-1111-4111-8111-111111111111", ssid: "Home", autoconnect: true, active: true };
const office = { id: "22222222-2222-4222-8222-222222222222", ssid: "Office", autoconnect: true, active: false };
function clientState() {
  return {
    supported: true,
    enabled: true,
    hardwareEnabled: true,
    device: "wlan0",
    mode: "client",
    state: "connected",
    viaWifi: false,
    current: { id: home.id, ssid: "Home", signal: 72, security: "WPA2", frequency: 2437, ipv4: "192.168.1.20/24" },
    saved: [home, office],
    hotspot: { ...hotspotDefaults },
  };
}
const networks = [
  { ssid: "Home", signal: 72, security: "WPA2", frequency: 2437, saved: true, active: true },
  { ssid: "Office", signal: 55, security: "WPA2 WPA3", frequency: 5200, saved: true, active: false },
  { ssid: "Cafe", signal: 40, security: "", frequency: 2412, saved: false, active: false },
  { ssid: "Neighbor", signal: 20, security: "WPA2", frequency: 2462, saved: false, active: false },
];
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  await (await import("./auth-fixture.mjs")).pinLanguage(page);
  await (await import("./auth-fixture.mjs")).pinLanguage(page);
  let state = { supported: true, enabled: false, hardwareEnabled: true, mode: "off", saved: [], current: null, hotspot: hotspotDefaults };
  let failWrite = false;
  const writes = [];
  const scans = [];
  await page.route("**/api/wifi**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/wifi/networks") {
      scans.push(url.search);
      return route.fulfill({ json: { networks: state.mode === "client" ? networks : [] } });
    }
    if (route.request().method() === "POST") {
      const data = route.request().postDataJSON();
      writes.push({ path: url.pathname, ...data });
      if (failWrite) return route.fulfill({ status: 400, json: { error: "Couldn't change the Wi-Fi mode. Try again." } });
      if (url.pathname === "/api/wifi") state = data.enabled ? { ...clientState() } : { ...state, enabled: false, mode: "off" };
      if (url.pathname === "/api/wifi/mode")
        state = data.mode === "hotspot"
          ? { ...state, mode: "hotspot", current: null,
              hotspot: { ...state.hotspot, active: true, clients: [{ mac: "aa:bb:cc:dd:ee:ff", ip: "10.42.0.23", hostname: "macbook" }] } }
          : { ...clientState(), hotspot: { ...state.hotspot, active: false, clients: [] } };
      if (url.pathname === "/api/wifi/hotspot")
        state = { ...state, hotspot: { ...state.hotspot, ssid: data.ssid, channel: data.channel, autostart: data.autostart,
          password: data.password || state.hotspot.password } };
      if (url.pathname === "/api/wifi/forget")
        state = { ...state, saved: state.saved.filter((s) => s.id !== data.id) };
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: state });
  });
  const url = `${process.env.TEST_URL || "http://127.0.0.1:5188"}/tests/wifi.html`;
  const toggle = page.getByRole("switch", { name: "Wi-Fi", exact: true });
  await page.goto(url);
  await page.getByText("Off", { exact: true }).waitFor();
  assert.deepEqual(writes, [], "reading state must not change the radio");
  assert.equal(await page.getByRole("group", { name: "Wi-Fi mode" }).count(), 0, "modes are hidden while the radio is off");

  await toggle.click();
  await page.getByText("On", { exact: true }).waitFor();
  await page.getByText("192.168.1.20/24 · 2.4 GHz · WPA2").waitFor();
  const list = page.getByRole("list", { name: "Nearby networks" });
  await list.waitFor();
  assert.equal(await list.getByRole("listitem").count(), 3, "the active network is shown above, not in the list");
  assert(scans.includes("?rescan=1"), "first view triggers a rescan");

  // Saved networks connect without a password prompt.
  await list.getByRole("button", { name: /Office/ }).click();
  await page.getByText("On", { exact: true }).waitFor();
  assert.deepEqual(writes.at(-1), { path: "/api/wifi/activate", id: office.id });

  // New secured network: password is validated before submit.
  await list.getByRole("button", { name: /Neighbor/ }).click();
  const password = page.getByLabel(/^Password/);
  const connect = page.getByRole("button", { name: "Connect", exact: true });
  await password.fill("short");
  assert(await connect.isDisabled());
  await page.getByText("Use 8–63 characters or a 64-digit hexadecimal key").waitFor();
  await password.fill("correct horse");
  assert.equal(await password.getAttribute("type"), "password", "join password starts hidden");
  const join = page.getByRole("form", { name: "Join network" });
  await join.getByRole("button", { name: "Show password" }).click();
  assert.equal(await password.getAttribute("type"), "text");
  assert.equal(await password.inputValue(), "correct horse", "toggling keeps the typed password");
  await join.getByRole("button", { name: "Hide password" }).click();
  assert.equal(await password.getAttribute("type"), "password");
  assert.equal(writes.at(-1).path, "/api/wifi/activate", "the eye button must not submit the form");
  await password.press("Enter");
  await page.getByText("On", { exact: true }).waitFor();
  assert.deepEqual(writes.at(-1), { path: "/api/wifi/connect", ssid: "Neighbor", password: "correct horse", hidden: false });

  // Open network connects with an empty password and no password field.
  await list.getByRole("button", { name: /Cafe/ }).click();
  assert.equal(await page.getByLabel(/^Password/).count(), 0);
  await connect.click();
  await page.getByText("On", { exact: true }).waitFor();
  assert.deepEqual(writes.at(-1), { path: "/api/wifi/connect", ssid: "Cafe", password: "", hidden: false });

  // Hidden network.
  await page.getByRole("button", { name: "Join hidden network" }).click();
  await page.getByLabel("Network name (SSID)").fill("Secret Lab");
  await page.getByLabel(/^Password/).fill("labpassword");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByText("On", { exact: true }).waitFor();
  assert.deepEqual(writes.at(-1), { path: "/api/wifi/connect", ssid: "Secret Lab", password: "labpassword", hidden: true });

  // Saved list: forget requires confirmation; cancel sends nothing.
  await page.getByRole("button", { name: /Saved networks/ }).click();
  const saved = page.getByRole("list", { name: "Saved networks" });
  const before = writes.length;
  await saved.getByRole("listitem").filter({ hasText: "Office" }).getByRole("button", { name: "Forget" }).click();
  await page.getByRole("alertdialog", { name: "Forget network" }).getByRole("button", { name: "Cancel" }).click();
  assert.equal(writes.length, before);
  await saved.getByRole("listitem").filter({ hasText: "Office" }).getByRole("button", { name: "Forget" }).click();
  await page.getByRole("alertdialog", { name: "Forget network" }).getByRole("button", { name: "Forget network" }).click();
  await page.getByText("On", { exact: true }).waitFor();
  assert.deepEqual(writes.at(-1), { path: "/api/wifi/forget", id: office.id });
  await saved.getByRole("listitem").filter({ hasText: "Office" }).waitFor({ state: "detached" });

  // Switch to hotspot: confirmation names the hotspot and its address, warns when on Wi-Fi.
  state = { ...state, viaWifi: true };
  await page.waitForTimeout(3200);
  await page.getByRole("button", { name: /Hotspot/ }).click();
  const dialog = page.getByRole("alertdialog", { name: "Start hotspot" });
  await dialog.getByText(/Wi-Fi session.*VIM4-KVM-BC28.*http:\/\/10\.42\.0\.1/).waitFor();
  await dialog.getByRole("button", { name: "Start hotspot" }).click();
  await page.getByText("Broadcasting").waitFor();
  assert.deepEqual(writes.at(-1), { path: "/api/wifi/mode", mode: "hotspot", force: false });
  const selected = page.getByRole("button", { name: /^Hotspot/ });
  await selected.hover();
  await page.waitForTimeout(250);
  const [background, ink] = await selected.evaluate((e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e.querySelector("strong")).color]);
  assert.notEqual(background, ink, "hovering the selected mode must keep its text readable");
  assert(!background.startsWith("rgba"), "the selected mode keeps its solid background on hover");
  await page.getByText("http://10.42.0.1:8080").waitFor();
  await page.getByRole("list", { name: "Connected devices" }).getByText("macbook").waitFor();
  assert.equal(await page.getByText("k7mpq4xr2wzt").count(), 0, "password is masked by default");
  await page.getByRole("button", { name: "Show password" }).click();
  await page.getByText("k7mpq4xr2wzt").waitFor();
  await page.getByRole("button", { name: "Hide password" }).waitFor();

  // QR sharing: join the hotspot first, then open the panel; Esc closes.
  await page.getByRole("button", { name: "Scan to join hotspot" }).click();
  const share = page.getByRole("dialog", { name: "Scan to connect" });
  await share.getByRole("img", { name: "Join hotspot QR code" }).waitFor();
  await share.getByText("VIM4-KVM-BC28", { exact: true }).waitFor();
  await share.getByRole("button", { name: /Manager/ }).click();
  await share.getByRole("img", { name: "Manager QR code" }).waitFor();
  await share.getByText("http://10.42.0.1", { exact: true }).waitFor();
  await share.getByRole("button", { name: /KVM interface/ }).click();
  await share.getByText("http://10.42.0.1:8080", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await share.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Scan to join hotspot" }).click();
  await share.getByRole("button", { name: "Close" }).click();
  await share.waitFor({ state: "detached" });

  // Edit hotspot settings: empty password keeps the existing one.
  await page.getByRole("button", { name: "Edit hotspot settings" }).click();
  await page.getByLabel("Network name", { exact: true }).fill("");
  await page.getByText("1–32 bytes, without control characters").waitFor();
  assert(await page.getByRole("button", { name: "Save", exact: true }).isDisabled());
  await page.getByLabel(/^Network name/).fill("Desk KVM");
  await page.getByLabel(/^New password/).fill("1234567");
  assert(await page.getByRole("button", { name: "Save", exact: true }).isDisabled());
  await page.getByLabel(/^New password/).fill("");
  await page.getByLabel("Channel").selectOption("6");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Desk KVM").waitFor();
  assert.deepEqual(writes.at(-1), { path: "/api/wifi/hotspot", ssid: "Desk KVM", password: "", channel: 6, autostart: false });
  const autostart = page.getByLabel("Start hotspot at boot");
  await autostart.click();
  await page.waitForFunction(() => document.querySelector('[role="checkbox"][aria-label="Start hotspot at boot"]')?.getAttribute("aria-checked") === "true");
  assert.deepEqual(writes.at(-1), { path: "/api/wifi/hotspot", ssid: "Desk KVM", password: "", channel: 6, autostart: true });

  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByText("Broadcasting").waitFor();
    await page.waitForTimeout(400);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `/tmp/manager-wifi-hotspot-${colorScheme}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });

  // No saved network over a wired session: switching must not demand a fallback
  // network, or the board could never leave hotspot mode to scan for one.
  const kept = { viaWifi: state.viaWifi, saved: state.saved };
  state = { ...state, viaWifi: false, saved: [] };
  await page.waitForTimeout(3200);
  await page.getByRole("button", { name: /^Join network/ }).click();
  await page.getByRole("alertdialog", { name: "Switch to Wi-Fi" }).getByText(/Choose a network from the list afterward. The hotspot will stay off if the connection fails./).waitFor();
  await page.getByRole("alertdialog").getByRole("button", { name: "Switch to Wi-Fi" }).click();
  await page.getByText("192.168.1.20/24 · 2.4 GHz · WPA2").waitFor();
  assert.deepEqual(writes.at(-1), { path: "/api/wifi/mode", mode: "client", force: true });
  await page.getByRole("button", { name: /^Hotspot/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Start hotspot" }).click();
  await page.getByText("Broadcasting").waitFor();
  state = { ...state, viaWifi: kept.viaWifi, saved: kept.saved };
  await page.waitForTimeout(3200);

  // Over Wi-Fi with a saved network: keep the fallback, surface failure, view unchanged.
  failWrite = true;
  await page.getByRole("button", { name: /Join network/ }).click();
  await page.getByRole("alertdialog", { name: "Switch to Wi-Fi" }).getByText(/restore the hotspot if it cannot connect within 30 seconds/).waitFor();
  await page.getByRole("alertdialog").getByRole("button", { name: "Switch to Wi-Fi" }).click();
  await page.getByRole("alert").waitFor();
  await page.getByText("Broadcasting").waitFor();
  failWrite = false;
  await page.getByRole("button", { name: /Join network/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Switch to Wi-Fi" }).click();
  await page.getByText("192.168.1.20/24 · 2.4 GHz · WPA2").waitFor();
  assert.deepEqual(writes.at(-1), { path: "/api/wifi/mode", mode: "client", force: false });

  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 375, height: 812 });
    await list.waitFor();
    await page.waitForTimeout(400);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `/tmp/manager-wifi-${colorScheme}.png`, fullPage: true });
  }

  // Disabling the radio still asks first.
  await toggle.click();
  await page.getByRole("alertdialog", { name: "Turn off Wi-Fi" }).getByRole("button", { name: "Turn off Wi-Fi" }).click();
  await page.getByText("Off", { exact: true }).waitFor();
  assert.deepEqual(writes.at(-1), { path: "/api/wifi", enabled: false });

  for (const value of [
    { supported: false, enabled: false, hardwareEnabled: false },
    { supported: true, enabled: false, hardwareEnabled: false },
  ]) {
    state = value;
    await page.reload();
    await page.getByText(value.supported ? "Wi-Fi hardware disabled" : "No Wi-Fi adapter detected", { exact: true }).waitFor();
    assert(await toggle.isDisabled());
  }
  state = clientState();
  await page.reload();
  await page.getByText("On", { exact: true }).waitFor();
  const localeRead = page.waitForRequest(request => new URL(request.url()).pathname === "/api/wifi", { timeout: 1500 });
  await page.evaluate(() => {
    localStorage.setItem("vim4-manager-language", "zh-CN");
    window.dispatchEvent(new StorageEvent("storage", { key: "vim4-manager-language", newValue: "zh-CN" }));
  });
  assert.match((await localeRead).headers().cookie, /vim4_lang=zh-CN/);
  await page.getByRole("group", { name: "无线模式" }).waitFor();
  await page.getByText("已开启", { exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
  console.log(
    "Wi-Fi UI checks passed: radio, scan, saved/new/open/hidden connect, forget, hotspot switch, settings, failure, mobile light/dark.",
  );
} finally {
  await browser.close();
}
