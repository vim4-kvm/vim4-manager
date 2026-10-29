import { ChevronDown, Languages } from "lucide-react";
import { useState } from "react";
import { Spinner } from "./Spinner";
import { languageChoices, selectLocale, useLocale, useT, type Locale } from "@/i18n";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export function LanguageMenu({ login = false, initialOpen = false }: { login?: boolean; initialOpen?: boolean }) {
  const locale = useLocale();
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  async function change(value: Locale) {
    const timer = window.setTimeout(() => setLoading(true), 150);
    setError(false);
    try { await selectLocale(value); }
    catch { setError(true); }
    finally { window.clearTimeout(timer); setLoading(false); }
  }
  return <DropdownMenu modal={false} defaultOpen={initialOpen}>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" size={login ? "sm" : "icon"} className={login ? undefined : "rounded-full"}
        aria-label={t("common.language")} title={error ? t("common.connectionFailed") : t("common.language")}>
        {loading ? <Spinner className="size-5" /> : <Languages aria-hidden="true" className="size-5" />}
        {login && <>{languageChoices.find((choice) => choice.value === locale)!.label}<ChevronDown aria-hidden="true" className="size-3.5" /></>}
        {error && <span role="alert" className="sr-only">{t("common.connectionFailed")}</span>}
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent loop align="end" aria-label={t("common.language")}>
      <DropdownMenuRadioGroup value={locale} onValueChange={(value) => void change(value as Locale)}>
        {languageChoices.map((choice) => <DropdownMenuRadioItem key={choice.value} value={choice.value} className="min-h-8">{choice.label}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}
