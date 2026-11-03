// Kernel card review matrix: both languages, light/dark, 1280/390, using the shared offline fixtures.
// node web/tests/kernel-screens.mjs [output-dir]
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fixtures, vendorRelease } from "./ui-fixtures.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.TEST_URL || "http://127.0.0.1:5188";
const out = process.argv[2] || "docs/ui-refactor/screens/kernel-naming";
const legacy = "7.3.1-vim4kvm-uhd7+";
const dated = "7.3.1-vim4-20261103";
const copy = {
  en: { mainline: "Mainline kernel", vendor: "Vendor kernel", built: "Linux 7.3.1 · built 2026-11-03", switch: "Switch and restart", dialog: "Switch to Vendor kernel" },
  "zh-CN": { mainline: "主线内核", vendor: "厂商内核", built: "Linux 7.3.1 · 2026-11-03 构建", switch: "切换并重启", dialog: "切换到厂商内核" },
};
const kernels = (mainline, { vendorSelected = false, error = "" } = {}) => [
  { id: "vendor", name: "Linux 5.15", release: vendorRelease, selected: vendorSelected, available: true, error: "" },
  { id: "mainline", name: "Linux 7.x", release: mainline, selected: !vendorSelected, available: !error, error },
];
const states = [
  { name: "mainline-running-default", kernel: { running: dated, kernels: kernels(dated) } },
  { name: "mainline-running-default-legacy", kernel: { running: legacy, kernels: kernels(legacy) } },
  { name: "vendor-default-mainline-running", kernel: { running: dated, kernels: kernels(dated, { vendorSelected: true }) } },
  { name: "mainline-unavailable-error", kernel: { running: vendorRelease, kernels: kernels(dated, { vendorSelected: true, error: "Kernel checksum mismatch: Image" }) } },
  { name: "confirm-dialog", kernel: { running: dated, kernels: kernels(dated) }, dialog: true },
];

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const captures = [];
try {
  for (const locale of ["zh-CN", "en"]) for (const theme of ["light", "dark"]) for (const width of [1280, 390]) for (const state of states) {
    const data = fixtures(locale);
    data.kernel = state.kernel;
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: theme, reducedMotion: "reduce", locale });
    await context.addInitScript(({ locale, theme }) => {
      localStorage.setItem("vim4-manager-language", locale);
      localStorage.setItem("vim4-manager-theme", theme);
    }, { locale, theme });
    await context.route("**/api/**", route => {
      const path = new URL(route.request().url()).pathname;
      const responses = { "/__vim4/api/auth/state": data.auth, "/api/status": data.status, "/api/kernel": data.kernel, "/api/updates": data.updates };
      return route.fulfill({ status: path in responses ? 200 : 404, json: responses[path] ?? { error: "Unexpected test API" } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const name = `${state.name}-${locale}-${theme}-${width}.png`;
    try {
      await page.goto(`${base}/#/updates`);
      const text = copy[locale];
      const panel = page.getByRole("region", { name: locale === "en" ? "Kernel" : "内核", exact: true });
      const mainline = panel.getByRole("group", { name: text.mainline, exact: true });
      const vendor = panel.getByRole("group", { name: text.vendor, exact: true });
      await mainline.getByText(text.built, { exact: true }).or(mainline.getByText("Linux 7.3.1", { exact: true })).waitFor();
      await vendor.getByText("Linux 5.15.137", { exact: true }).waitFor();
      for (const card of [mainline, vendor]) {
        // Badges stay on the title line and the release stays inside the card.
        const heading = await card.getByRole("heading").boundingBox();
        for (const badge of await card.locator('[data-slot="badge"]').all()) {
          const box = await badge.boundingBox();
          assert(Math.abs(box.y + box.height / 2 - (heading.y + heading.height / 2)) < 4, `${name}: badge wraps below the title`);
        }
        const release = card.locator(".font-mono");
        assert(await release.evaluate(el => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= el.closest("[role=group]").getBoundingClientRect().right + 1), `${name}: release overflows its card`);
      }
      if (state.dialog) {
        await vendor.getByRole("button", { name: text.switch, exact: true }).click();
        await page.getByRole("alertdialog").getByRole("heading", { name: text.dialog, exact: true }).waitFor();
      }
      await page.evaluate(() => document.fonts.ready);
      assert.deepEqual(errors, [], name);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: horizontal overflow`);
      await page.mouse.move(0, 0);
      if (state.dialog) await page.screenshot({ path: `${out}/${name}`, animations: "disabled" });
      else {
        const box = await panel.boundingBox();
        const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
        await page.screenshot({ path: `${out}/${name}`, fullPage: true, animations: "disabled",
          clip: { x: Math.max(0, box.x + scroll.x - 16), y: Math.max(0, box.y + scroll.y - 16), width: Math.min(width, box.width + 32), height: box.height + 32 } });
      }
      captures.push(name);
      console.log(name);
    } finally { await context.close(); }
  }
  await writeFile(`${out}/manifest.json`, JSON.stringify({ base, themes: ["light", "dark"], widths: [1280, 390], locales: ["zh-CN", "en"], states: states.map(state => state.name), captures }, null, 2) + "\n");
  console.log(`PASS: ${captures.length} kernel screenshots in ${out}`);
} finally { await browser.close(); }
