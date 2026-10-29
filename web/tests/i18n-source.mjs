import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
const root = new URL("../src/", import.meta.url);
const violations = [];
for (const file of await readdir(root, { recursive: true })) {
  if (file === "i18n/zh-CN.ts" || !/\.(tsx?|css)$/.test(file)) continue;
  const text = await readFile(new URL(file, root), "utf8");
  for (const [index, line] of text.split("\n").entries()) {
    const allowed = file === "i18n/index.ts" ? line.replace("简体中文", "") : line;
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(allowed)) violations.push(`${file}:${index + 1}`);
  }
}
assert.equal(violations.length, 0, `CJK text outside the Chinese catalog (${violations.length} lines):\n${violations.join("\n")}`);
console.log("No CJK text outside the Chinese catalog");
