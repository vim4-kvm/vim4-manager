import { Moon, Sun } from "lucide-react";
import { selectTheme, themeChoices, useResolvedTheme, useThemePreference, type Theme } from "@/theme";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function ThemeSwitch() {
  const theme = useThemePreference();
  const resolved = useResolvedTheme();
  const Icon = resolved === "dark" ? Moon : Sun;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full" aria-label="切换外观" title="切换外观">
          <Icon aria-hidden="true" className="size-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label="外观">
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
