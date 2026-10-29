import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  await (await import("./auth-fixture.mjs")).pinLanguage(page);
  await (await import("./auth-fixture.mjs")).pinLanguage(page);
  const online = {
    installed: true,
    running: true,
    backendState: "Running",
    hostName: "vim4",
    dnsName: "vim4.tail1234.ts.net",
    ips: ["100.64.0.7", "fd7a:115c:a1e0::7"],
    tailnet: "user@example.com",
    controlURL: "https://controlplane.tailscale.com",
    version: "1.104.0",
    peers: 3,
    peersOnline: 2,
    devices: [
      { id: "a", hostName: "macbook", dnsName: "macbook.tail1234.ts.net", os: "macOS", ips: ["100.64.0.2", "fd7a:115c:a1e0::2"], online: true, lastSeen: "", curAddr: "192.168.1.5:41641", relay: "sin", exitNode: false, active: true },
      { id: "b", hostName: "phone", dnsName: "phone.tail1234.ts.net", os: "android", ips: ["100.64.0.3"], online: true, lastSeen: "", curAddr: "", relay: "hkg", exitNode: false, active: false },
      { id: "c", hostName: "nas", dnsName: "nas.tail1234.ts.net", os: "linux", ips: ["100.64.0.4"], online: false, lastSeen: new Date(Date.now() - 3 * 86400000).toISOString(), curAddr: "", relay: "", exitNode: false, active: false },
    ],
  };
  const pings = {
    "100.64.0.2": { reachable: true, path: "direct", via: "192.168.1.5:41641", latencyMs: [1.2, 0.9, 1.1, 1.0], lost: 0, sent: 4 },
    "100.64.0.3": { reachable: true, path: "derp", via: "hkg", latencyMs: [48, 52, 50], lost: 1, sent: 4 },
    "100.64.0.4": { reachable: false, path: "", via: "", latencyMs: [], lost: 4, sent: 4 },
  };
  const pinged = [];
  await page.route("**/api/tailscale/ping", async (route) => {
    const { ip } = route.request().postDataJSON();
    pinged.push(ip);
    await new Promise((r) => setTimeout(r, 200));
    return route.fulfill({ json: pings[ip] });
  });
  let state = { installed: false };
  let failWrite = false;
  const writes = [];
  await page.route("**/api/tailscale", async (route) => {
    if (route.request().method() === "POST") {
      const data = route.request().postDataJSON();
      writes.push(data);
      if (failWrite)
        return route.fulfill({ status: 500, json: { error: "Couldn't complete the action. Try again." } });
      switch (data.action) {
        case "install":
          state = { installed: true, running: true, backendState: "NeedsLogin" };
          break;
        case "login":
          state = { ...state, authURL: `${data.controlURL}/a/xyz` };
          return route.fulfill({ json: { authURL: state.authURL } });
        case "down":
          state = { ...state, backendState: "Stopped" };
          break;
        case "up":
          state = { ...state, backendState: "Running" };
          break;
        case "logout":
          state = { installed: true, running: true, backendState: "NeedsLogin" };
          break;
        case "uninstall":
          state = { installed: false };
          break;
      }
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: state });
  });
  const url = `${process.env.TEST_URL || "http://127.0.0.1:5188"}/tests/tailscale.html`;
  const status = page.getByRole("status");
  await page.goto(url);
  await status.getByText("Not installed").waitFor();
  assert.deepEqual(writes, [], "reading state must not change Tailscale");

  await page.getByRole("button", { name: "Install Tailscale" }).click();
  await status.getByText("Signed out").waitFor();

  await page.getByRole("button", { name: /Custom/ }).click();
  const input = page.getByRole("textbox", { name: "Control server URL" });
  await input.fill("https://hs.example.com/path");
  assert(await page.getByRole("button", { name: "Get sign-in link" }).isDisabled());
  await input.fill("https://hs.example.com:8443");
  await page.getByRole("button", { name: "Get sign-in link" }).click();
  const login = page.getByRole("link", { name: "Open sign-in page" });
  await login.waitFor();
  assert.equal(await login.getAttribute("href"), "https://hs.example.com:8443/a/xyz");
  assert.deepEqual(writes.at(-1), { action: "login", controlURL: "https://hs.example.com:8443" });

  state = { ...online, controlURL: "https://hs.example.com:8443" };
  await status.getByText("Connected").waitFor();
  await page.getByRole("link", { name: "http://100.64.0.7:8080" }).waitFor();
  await page.getByRole("link", { name: "http://vim4.tail1234.ts.net:8080" }).waitFor();
  await page.getByRole("link", { name: "http://100.64.0.7", exact: true }).waitFor();
  assert.equal(await page.getByText("2 of 3 online", { exact: true }).count(), 2, "summary and device list agree");
  assert.equal(await page.getByText("nas", { exact: true }).count(), 0, "offline devices start collapsed");

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy macbook address" }).click();
  await page.getByRole("button", { name: "Copy macbook address" }).getByText("Copied").waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "100.64.0.2");

  await page.getByRole("button", { name: "Test connection to macbook" }).click();
  await page.getByText("Direct · 1.1 ms").waitFor();
  await page.getByRole("button", { name: "Test connection to phone" }).click();
  await page.getByText(/DERP relay hkg · 50 ms · Lost 1\/4/).waitFor();
  await page.getByRole("button", { name: "Show 1 offline device" }).click();
  await page.getByText("Last seen 3 days ago").waitFor();
  await page.getByRole("button", { name: "Test connection to nas" }).click();
  await page.getByText("No response (all 4 probes timed out)").waitFor();
  assert.deepEqual(pinged, ["100.64.0.2", "100.64.0.3", "100.64.0.4"]);
  assert.equal(await login.count(), 0, "connected state must not show the stale login link");

  const toggle = page.getByRole("switch", { name: "Tailscale connection" });
  await toggle.click();
  assert.equal(writes.at(-1).action, "login", "disconnect must await confirmation");
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await toggle.click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect", exact: true }).click();
  await status.getByText("Disconnected").waitFor();
  assert.equal(writes.at(-1).confirmed, true);
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  await toggle.click();
  await status.getByText("Connected").waitFor();

  await page.getByRole("button", { name: "Change control server" }).click();
  await page.getByRole("textbox", { name: "Control server URL" }).fill("https://new.example");
  await page.getByRole("button", { name: "Get sign-in link" }).click();
  await page.getByRole("alertdialog", { name: "Change control server" }).waitFor();
  assert.equal(writes.at(-1).action, "up", "server change must await confirmation");
  await page.getByRole("alertdialog").getByRole("button", { name: "Change server" }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  assert.deepEqual(writes.at(-1), { action: "login", controlURL: "https://new.example", previousControlURL: "https://hs.example.com:8443", confirmed: true });

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  assert.equal(writes.at(-1).action, "login", "cancelling must not log out");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Sign out" }).click();
  await status.getByText("Signed out").waitFor();

  failWrite = true;
  await page.getByRole("button", { name: "Get sign-in link" }).click();
  await page.getByText("Couldn't complete the action. Try again.").waitFor();
  failWrite = false;

  state = { installed: true, running: true, backendState: "NeedsLogin", authURL: "javascript:alert(1)" };
  await page.reload();
  await status.getByText("Signed out").waitFor();
  assert.equal(await page.getByRole("link", { name: "Open sign-in page" }).count(), 0);
  await page.getByRole("button", { name: "Get sign-in link" }).waitFor();

  state = { ...online, writable: true };
  await page.reload();
  await status.getByText("Connected").waitFor();
  assert(await toggle.isEnabled());
  assert(await page.getByRole("button", { name: "Test connection to macbook" }).isEnabled());

  state = { installed: true, job: { action: "uninstall", running: true } };
  await status.getByText("Uninstalling Tailscale…").waitFor();
  assert.equal(await page.getByRole("button", { name: "Uninstall" }).count(), 0);
  state = { installed: false, job: { action: "install", running: false, error: "Couldn't download the repository key. Try again." } };
  await page.getByText("Couldn't download the repository key. Try again.").waitFor();

  state = { ...online, authURL: "javascript:alert(1)" };
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();
    await status.getByText("Connected").waitFor();
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    );
    await page.screenshot({ path: `/tmp/manager-tailscale-${colorScheme}.png`, fullPage: true });
  }
  console.log(
    "Tailscale UI checks passed: install, Headscale, safe login links, disconnect and server-switch confirmation, remote read-only state, logout confirmation, failure, background job, access URLs, copy, device list, ping direct/DERP/timeout, mobile light/dark.",
  );
} finally {
  await browser.close();
}
