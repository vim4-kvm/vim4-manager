import { defineCatalog } from "./catalog";
import { zhCN } from "./zh-CN";
import { t } from ".";

// These negative assertions are checked by the normal tsc build.
// @ts-expect-error Extra catalog keys must fail.
defineCatalog({ ...zhCN, "unknown.key": "unexpected" });
const { "common.save": _save, ...missing } = zhCN;
// @ts-expect-error Missing catalog keys must fail.
defineCatalog(missing);
// @ts-expect-error Changed interpolation parameters must fail.
defineCatalog({ ...zhCN, "login.retryAfter": { one: "{seconds}", other: "{seconds}" } });
// @ts-expect-error Missing interpolation arguments must fail.
t("login.retryAfter");
// @ts-expect-error Unexpected interpolation arguments must fail.
t("login.retryAfter", { seconds: 3 });
