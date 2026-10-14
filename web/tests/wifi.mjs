import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  let state = { supported: true, enabled: false, hardwareEnabled: true };
  let failWrite = false;
  const writes = [];
  await page.route("**/api/wifi", async (route) => {
    if (route.request().method() === "POST") {
      const data = route.request().postDataJSON();
      writes.push(data);
      if (failWrite)
        return route.fulfill({ status: 400, json: { error: "切换失败" } });
      state = { ...state, enabled: data.enabled };
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: state });
  });
  const url = `${process.env.TEST_URL || "http://127.0.0.1:5188"}/tests/wifi.html`;
  const toggle = page.getByRole("switch", { name: "Wi-Fi", exact: true });
  await page.goto(url);
  await page.getByText("已关闭", { exact: true }).waitFor();
  assert.deepEqual(writes, [], "reading state must not change the radio");
  await toggle.click();
  await page.getByText("已开启", { exact: true }).waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await toggle.click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(writes.length, 1, "cancelling must not disable the radio");
  await toggle.click();
  await page.getByRole("button", { name: "关闭 Wi-Fi", exact: true }).click();
  await page.getByText("已关闭", { exact: true }).waitFor();
  assert.deepEqual(writes, [{ enabled: true }, { enabled: false }]);
  failWrite = true;
  await toggle.click();
  await page.getByRole("alert").waitFor();
  await page.getByText("已关闭", { exact: true }).waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  for (const value of [
    { supported: false, enabled: false, hardwareEnabled: false },
    { supported: true, enabled: false, hardwareEnabled: false },
  ]) {
    state = value;
    await page.reload();
    await page
      .getByText(value.supported ? "无线硬件已禁用" : "未检测到无线网卡", {
        exact: true,
      })
      .waitFor();
    assert(await toggle.isDisabled());
  }
  state = { supported: true, enabled: true, hardwareEnabled: true };
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();
    await page.getByText("已开启", { exact: true }).waitFor();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({ path: `/tmp/manager-wifi-${colorScheme}.png` });
  }
  console.log(
    "Wi-Fi UI checks passed: enable, confirmation, cancel, disable, failure, unavailable hardware, mobile light/dark.",
  );
} finally {
  await browser.close();
}
