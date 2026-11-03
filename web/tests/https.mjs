import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fixtures, localizeResponse } from "./ui-fixtures.mjs";
import { pinLanguage } from "./auth-fixture.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

// Usage: node web/tests/https.mjs [screenshot-dir]
// Checks the Network page HTTPS card and the Tailscale card's access URLs against a mocked API.
const base = process.env.TEST_URL || "http://127.0.0.1:5188";
const out = process.argv[2];

function mockData(edit) {
  const data = fixtures();
  data.tailscale = { ...data.tailscale, dnsName: "khadas.tailb66bbe.ts.net", ips: ["100.87.252.96", "fd7a:115c:a1e0::7"] };
  data.https.tailscale = { state: "issued", name: "khadas.tailb66bbe.ts.net", not_after: "2027-01-30T00:00:00Z" };
  data.writes = [];
  edit?.(data);
  return data;
}

async function open(browser, data, { width = 1440, locale = "en", theme = "light" } = {}) {
  const context = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 1000 }, colorScheme: theme, reducedMotion: "reduce", deviceScaleFactor: 2, timezoneId: "Asia/Shanghai" });
  await context.addInitScript((theme) => localStorage.setItem("vim4-manager-theme", theme), theme);
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/__vim4/api/https") {
      if (data.hold) return; // Never answers: the loading state.
      if (data.httpsError) return route.fulfill({ status: 503, json: { error: "unavailable" } });
      if (request.method() === "PUT") {
        const body = request.postDataJSON();
        data.writes.push(body);
        if (data.putError) return route.fulfill({ status: 500, json: { error: data.putError } });
        if (!body.http_enabled && !data.https.request_secure) return route.fulfill({ status: 409, json: { error: "https_required" } });
        data.https = { ...data.https, http_enabled: body.http_enabled };
      }
      return route.fulfill({ json: data.https });
    }
    if (path === "/__vim4/api/https/tailscale/retry") {
      data.writes.push("retry");
      data.https = { ...data.https, tailscale: { state: "pending" } };
      return route.fulfill({ status: 202, json: {} });
    }
    const responses = {
      "/__vim4/api/auth/state": data.auth, "/api/status": data.status, "/api/wifi": data.wifi,
      "/api/wifi/networks": { networks: data.networks }, "/api/tailscale": data.tailscale,
    };
    return route.fulfill({ status: path in responses ? 200 : 404, json: localizeResponse(path, responses[path], request.headers().cookie) ?? { error: "Unexpected test API" } });
  });
  const page = await context.newPage();
  await pinLanguage(page, locale);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/#/network`);
  return { page, context, errors, card: page.getByRole("region", { name: "HTTPS", exact: true }), tailscale: page.getByRole("region", { name: "Tailscale", exact: true }) };
}

const urlsIn = (region) => region.locator("ul a.font-mono").allTextContents();

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  // Tailscale access URLs: an issued certificate wins; otherwise the HTTP switch picks the scheme.
  for (const [name, edit, expected] of [
    ["issued", undefined, ["https://khadas.tailb66bbe.ts.net:8443", "https://khadas.tailb66bbe.ts.net"]],
    ["http on", (d) => { d.https.tailscale = { state: "disabled" }; }, ["http://100.87.252.96:8080", "http://khadas.tailb66bbe.ts.net:8080", "http://100.87.252.96"]],
    ["http off", (d) => { d.https.tailscale = { state: "error", error: "x" }; d.https.http_enabled = false; }, ["https://100.87.252.96:8443", "https://khadas.tailb66bbe.ts.net:8443", "https://100.87.252.96"]],
    // Ports come from the API's URLs, so custom TLS listeners carry over to the Tailscale names.
    ["issued, custom ports", (d) => { d.https.urls = { manager: "https://192.168.50.210:9443", kvm: "https://192.168.50.210:18443" }; }, ["https://khadas.tailb66bbe.ts.net:18443", "https://khadas.tailb66bbe.ts.net:9443"]],
    ["http off, custom ports", (d) => { ((d) => { d.https.urls = { manager: "https://192.168.50.210:9443", kvm: "https://192.168.50.210:18443" }; })(d); d.https.tailscale = { state: "disabled" }; d.https.http_enabled = false; }, ["https://100.87.252.96:18443", "https://khadas.tailb66bbe.ts.net:18443", "https://100.87.252.96:9443"]],
  ]) {
    const { page, context, tailscale } = await open(browser, mockData(edit));
    await tailscale.getByText("Access URLs").waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="HTTPS"] ul'));
    await page.waitForFunction((first) => [...document.querySelectorAll('[aria-label="Tailscale"] ul a')].some((a) => a.textContent === first), expected[0]);
    assert.deepEqual(await urlsIn(tailscale), expected, `Tailscale URLs: ${name}`);
    await context.close();
  }

  // Over HTTP the switch refuses to turn off and never calls the API.
  {
    const data = mockData();
    const { page, context, card, errors } = await open(browser, data);
    await card.getByText("You're on HTTP.").waitFor();
    assert.deepEqual(await urlsIn(card), ["https://192.168.50.210:8443", "https://192.168.50.210"]);
    assert.equal(await card.getByRole("link", { name: "Open over HTTPS" }).first().getAttribute("href"), "https://192.168.50.210/#/network");
    const toggle = card.getByRole("switch", { name: "Keep HTTP access" });
    await toggle.click();
    await card.getByText("Open this page over HTTPS first to confirm it works, then turn this off.").waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    assert.equal(await page.getByRole("alertdialog").count(), 0);
    assert.deepEqual(data.writes, []);
    // Trust help expands in place and wraps the fingerprint only at colons.
    await card.getByRole("button", { name: "How to trust" }).click();
    await card.getByText("Open the downloaded certificate in Keychain Access").waitFor();
    assert.equal(await card.getByRole("link", { name: "Download CA certificate" }).getAttribute("href"), "/__vim4/ca.crt");
    assert.match(await card.getByText(/^192\.168\.50\.210 · /).textContent(), /^192\.168\.50\.210 · 100\.64\.0\.7 · vim4 · vim4\.local and 3 more$/);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // Over HTTPS turning off asks first; turning on saves at once; failures revert with a toast.
  {
    const data = mockData((d) => { d.https.request_secure = true; });
    const { page, context, card, errors } = await open(browser, data);
    const toggle = card.getByRole("switch", { name: "Keep HTTP access" });
    await toggle.waitFor();
    assert.equal(await card.getByText("You're on HTTP.").count(), 0);
    await toggle.click();
    const dialog = page.getByRole("alertdialog", { name: "Turn off HTTP access?" });
    await dialog.getByText("sudo vim4-manager set-http on", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    assert.deepEqual(data.writes, []);
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    await toggle.click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Turn off HTTP" }).click();
    await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Keep HTTP access"]')?.getAttribute("aria-checked") === "false");
    assert.deepEqual(data.writes, [{ http_enabled: false }]);
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Keep HTTP access"]')?.getAttribute("aria-checked") === "true");
    assert.deepEqual(data.writes.at(-1), { http_enabled: true }, "turning on needs no confirmation");
    data.putError = "Couldn't save the setting.";
    await toggle.click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Turn off HTTP" }).click();
    await page.getByText("Couldn't save the setting.").waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "true", "a failed write reverts the switch");
    assert.deepEqual(errors, []);
    await context.close();
  }

  // KVM links follow the page scheme: an HTTPS page uses the gateway's TLS listener, an HTTP page keeps 8080.
  {
    const { page, context, card } = await open(browser, mockData());
    await card.locator("ul a").first().waitFor();
    const urls = await page.evaluate(async () => {
      const { kvmURL } = await import("/src/lib/units.ts");
      const { useHttpsStore } = await import("/src/stores/https.ts");
      const secure = { protocol: "https:", hostname: "vim4" };
      const loaded = kvmURL(8080, "onekvm", secure);
      const https = useHttpsStore.getState().https;
      useHttpsStore.setState({ https: { ...https, urls: { ...https.urls, kvm: "https://192.168.50.210:18443" } } });
      const custom = kvmURL(8080, "onekvm", secure);
      useHttpsStore.setState({ https: undefined });
      return { loaded, custom, unloaded: kvmURL(8080, "onekvm", secure), http: kvmURL(8080, "onekvm", { protocol: "http:", hostname: "vim4" }) };
    });
    assert.deepEqual(urls, { loaded: "https://vim4:8443/?kvm=onekvm", custom: "https://vim4:18443/?kvm=onekvm", unloaded: "https://vim4:8443/?kvm=onekvm", http: "http://vim4:8080/?kvm=onekvm" });
    await page.goto(`${base}/#/apps`);
    const appLink = page.getByRole("link", { name: "Open One-KVM" }).first();
    await appLink.waitFor();
    assert.equal(new URL(await appLink.getAttribute("href")).port, "8080", "HTTP page opens the plain gateway");
    await context.close();
  }

  // A failed refresh after a good read keeps the facts but marks them stale and locks the controls.
  {
    const data = mockData((d) => { d.https.tailscale = { state: "error", error: "x" }; });
    const { page, context, card, errors } = await open(browser, data);
    const toggle = card.getByRole("switch", { name: "Keep HTTP access" });
    await toggle.waitFor();
    assert(await toggle.isEnabled());
    data.httpsError = true;
    const alert = card.getByRole("alert");
    await alert.getByText("Couldn't load HTTPS status.").waitFor({ timeout: 8000 });
    assert.equal(await alert.getByRole("link").count(), 0, "the HTTPS link stays only on the access URL line");
    const links = card.getByRole("link", { name: "Open over HTTPS" });
    assert.equal(await links.count(), 1);
    assert.equal(await links.getAttribute("href"), "https://192.168.50.210/#/network");
    await card.getByText("Local certificate").waitFor();
    assert(await toggle.isDisabled(), "switch locked while stale");
    assert(await card.getByRole("button", { name: "Retry", exact: true }).last().isDisabled(), "certificate retry locked while stale");
    await toggle.click({ force: true });
    assert.deepEqual(data.writes, []);
    data.httpsError = false;
    await alert.getByRole("button", { name: "Retry" }).click();
    await alert.waitFor({ state: "detached" });
    assert(await toggle.isEnabled(), "a fresh read unlocks the switch");
    assert.deepEqual(errors, []);
    await context.close();
  }

  // Load failure offers a retry; Tailscale certificate row hides when unavailable and retries on error.
  {
    const data = mockData((d) => { d.httpsError = true; d.https.tailscale = { state: "unavailable" }; });
    const { context, card } = await open(browser, data);
    await card.getByText("Couldn't load HTTPS status.").waitFor();
    data.httpsError = false;
    await card.getByRole("button", { name: "Retry" }).click();
    await card.getByText("Local certificate").waitFor();
    assert.equal(await card.getByText("Tailscale certificate").count(), 0);
    data.https = { ...data.https, tailscale: { state: "error", error: "tailscale cert: 500 Internal Server Error" } };
    await card.getByText("Request failed", { exact: true }).waitFor({ timeout: 8000 });
    assert.equal(await card.getByTitle("tailscale cert: 500 Internal Server Error").textContent(), "tailscale cert: 500 Internal Server Error");
    await card.getByRole("button", { name: "Retry" }).click();
    await card.getByText("Requesting…").waitFor();
    assert.deepEqual(data.writes, ["retry"]);
    await context.close();
  }

  // Phones: label above the URL; hosts and IPs never split; nothing overflows.
  for (const http of [true, false]) {
    const data = mockData((d) => { d.https.tailscale = { state: "disabled" }; d.https.http_enabled = http; });
    const { page, context, card, tailscale } = await open(browser, data, { width: 390 });
    await tailscale.getByText("MagicDNS", { exact: true }).waitFor();
    await card.locator("ul a").first().waitFor();
    const layout = await page.evaluate(() => [...document.querySelectorAll("main ul a.font-mono")].map((a) => ({
      url: a.textContent,
      unsplit: [...a.children].filter((s) => s.tagName === "SPAN").every((s) => s.getClientRects().length === 1),
      below: a.getBoundingClientRect().top >= a.parentElement.firstElementChild.getBoundingClientRect().bottom,
      fits: a.getBoundingClientRect().right <= a.closest("ul").getBoundingClientRect().right,
    })));
    assert.equal(layout.length, 5);
    for (const row of layout) assert(row.unsplit && row.below && row.fits, JSON.stringify(row));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal overflow at 390px");
    // The switch shares the title line on phones; the description runs full width below.
    const row = await page.evaluate(() => {
      const box = (el) => el.getBoundingClientRect();
      const toggle = document.querySelector('[role="switch"][aria-label="Keep HTTP access"]');
      const group = toggle.closest('[role="group"]');
      const [title, help] = [group.querySelector("h3"), group.querySelector("p")];
      return { centered: Math.abs((box(toggle).top + box(toggle).bottom) / 2 - (box(title).top + box(title).bottom) / 2) < 2,
        below: box(help).top >= box(title).bottom, full: box(help).width >= box(group).width - 1 };
    });
    assert(row.centered && row.below && row.full, JSON.stringify(row));
    await context.close();
  }
  console.log("HTTPS UI checks passed: Tailscale URL rows (issued, HTTP on, HTTP off, custom ports), stale read locks controls, KVM link ports (https → 8443/API port, http → 8080), HTTP-off guard over HTTP, confirm/cancel, turn on without dialog, failed write revert + toast, load retry, Tailscale certificate hidden/error retry, mobile URL wrapping.");

  if (out) await capture(out);
} finally {
  await browser.close();
}

async function capture(dir) {
  await mkdir(dir, { recursive: true });
  const secure = (d) => { d.https.request_secure = true; };
  const zh = { switch: "同时保留 HTTP 访问" };
  const scenarios = [
    { name: "loading", edit: (d) => { d.hold = true; }, ready: ({ card }) => card.locator('[aria-busy="true"]').waitFor() },
    { name: "stale-error", actions: [async ({ card }, data) => { data.httpsError = true; await card.getByText("无法读取 HTTPS 状态。").waitFor({ timeout: 8000 }); }] },
    { name: "load-error", edit: (d) => { d.httpsError = true; }, ready: ({ card }) => card.getByText("无法读取 HTTPS 状态。").waitFor() },
    { name: "http-page-http-on", full: true, themes: ["light", "dark"], locales: ["zh-CN", "en"] },
    { name: "https-page-http-on", edit: secure },
    { name: "http-off-attempt-over-http", actions: [async ({ card }) => { await card.getByRole("switch", { name: zh.switch }).click(); await card.getByText("请先通过 HTTPS 打开本页").waitFor(); }] },
    { name: "confirm-dialog", edit: secure, viewport: true, actions: [async ({ page, card }) => { await card.getByRole("switch", { name: zh.switch }).click(); await page.getByRole("alertdialog").waitFor(); }] },
    { name: "http-off", edit: (d) => { secure(d); d.https.http_enabled = false; } },
    { name: "tailscale-unavailable", edit: (d) => { d.https.tailscale = { state: "unavailable" }; } },
    { name: "tailscale-disabled", edit: (d) => { d.https.tailscale = { state: "disabled" }; } },
    { name: "tailscale-pending", edit: (d) => { d.https.tailscale = { state: "pending" }; } },
    { name: "tailscale-issued" },
    { name: "tailscale-error", locales: ["zh-CN", "en"], edit: (d) => { d.https.tailscale = { state: "error", error: "tailscale cert: 500 Internal Server Error: acme: authorization timed out" }; } },
    { name: "how-to-trust", actions: [async ({ card }) => { await card.getByRole("button", { name: "如何信任" }).click(); await card.getByText("钥匙串访问", { exact: false }).waitFor(); }] },
    { name: "tailscale-card-urls-issued", region: "tailscale" },
    { name: "tailscale-card-urls-http-on", region: "tailscale", edit: (d) => { d.https.tailscale = { state: "disabled" }; } },
    { name: "tailscale-card-urls-http-off", region: "tailscale", edit: (d) => { d.https.tailscale = { state: "disabled" }; d.https.http_enabled = false; } },
  ];
  for (const scenario of scenarios) for (const width of [1440, 390]) for (const theme of scenario.themes ?? ["light"]) for (const locale of scenario.locales ?? ["zh-CN"]) {
    if (process.env.SCREEN_FILTER && !process.env.SCREEN_FILTER.split(",").includes(scenario.name)) continue;
    if (process.env.SCREEN_THEME && theme !== process.env.SCREEN_THEME) continue;
    const data = mockData(scenario.edit);
    const view = await open(browser, data, { width, theme, locale });
    try {
      const region = scenario.region === "tailscale" ? view.tailscale : view.card;
      if (scenario.ready) await scenario.ready(view);
      else await region.locator("ul a").first().waitFor();
      if (scenario.region === "tailscale") await view.tailscale.getByText(data.https.tailscale.state === "issued" ? "https://khadas" : "MagicDNS", { exact: data.https.tailscale.state !== "issued" }).first().waitFor();
      for (const action of scenario.actions ?? []) await action(view, data);
      await view.page.evaluate(() => document.fonts.ready);
      assert.deepEqual(view.errors, [], scenario.name);
      assert(await view.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${scenario.name}: horizontal overflow at ${width}px`);
      await view.page.mouse.move(0, 0);
      // Card captures span the page; keep the sticky top bar from painting over them.
      if (!scenario.full && !scenario.viewport) await view.page.addStyleTag({ content: "header { position: static !important; }" });
      const file = `${dir}/${scenario.name}-${width === 390 ? "mobile" : "desktop"}-${theme}-${locale}.png`;
      if (scenario.full) await view.page.screenshot({ path: file, fullPage: true, animations: "disabled" });
      else if (scenario.viewport) await view.page.screenshot({ path: file, animations: "disabled" });
      else {
        const box = await region.boundingBox();
        const scroll = await view.page.evaluate(() => scrollY);
        const pad = 16;
        await view.page.screenshot({ path: file, fullPage: true, animations: "disabled",
          clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y + scroll - pad), width: Math.min(width, box.width + pad * 2), height: box.height + pad * 2 } });
      }
      console.log(file);
    } finally { await view.context.close(); }
  }
}
