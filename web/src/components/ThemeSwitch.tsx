import { Moon, Sun } from "lucide-react";
import { useT } from "@/i18n";
import { selectTheme, themeChoices, useResolvedTheme, useThemePreference, type Theme } from "@/theme";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function ThemeSwitch() {
  const t = useT();
  const theme = useThemePreference();
  const resolved = useResolvedTheme();
  const Icon = resolved === "dark" ? Moon : Sun;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full" aria-label={t("theme.switch")} title={t("theme.switch")}>
          <Icon aria-hidden="true" className="size-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent loop align="end" aria-label={t("theme.appearance")}>
        <DropdownMenuRadioGroup value={theme} onValueChange={(value) => selectTheme(value as Theme)}>
          {themeChoices.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} className="min-h-8">
              {option.title}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
