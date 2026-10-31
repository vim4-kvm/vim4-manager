import { useState } from "react";
import { ChevronDown, Languages } from "lucide-react";
import { languageChoices, useLocale, useT } from "@/i18n";
import { Button } from "./ui/button";
import { Spinner } from "./Spinner";
import type { LanguageMenu } from "./LanguageMenu";

/** The login entry loads menu primitives only when the user opens the menu. */
export function LanguageSwitch({ login = false }: { login?: boolean }) {
  const locale = useLocale();
  const t = useT();
  const [Menu, setMenu] = useState<typeof LanguageMenu>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  async function open() {
    const timer = window.setTimeout(() => setLoading(true), 150);
    try {
      const { LanguageMenu } = await import("./LanguageMenu");
      setMenu(() => LanguageMenu);
    } catch { setError(true); }
    finally { window.clearTimeout(timer); setLoading(false); }
  }
  if (Menu) return <Menu login={login} initialOpen />;
  return <Button variant="ghost" size={login ? "sm" : "icon"} className={login ? undefined : "rounded-full"}
    aria-label={t("common.language")} title={error ? t("common.connectionFailed") : t("common.language")}
    aria-haspopup="menu" aria-expanded={false} onClick={() => void open()}>
    {loading ? <Spinner className="size-5" /> : <Languages aria-hidden="true" className="size-5" />}
    {login && <>{languageChoices.find(choice => choice.value === locale)!.label}<ChevronDown aria-hidden="true" className="size-4" /></>}
    {error && <span role="alert" className="sr-only">{t("common.connectionFailed")}</span>}
  </Button>;
}
