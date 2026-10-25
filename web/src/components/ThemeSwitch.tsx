import { Monitor, Moon, Sun } from "lucide-react";
import { selectTheme, themeChoices, useThemePreference } from "@/theme";
import { cn } from "@/lib/utils";

const icons = { light: Sun, dark: Moon, system: Monitor };

/**
 * Light/dark/system radio group. Arrow keys select immediately and wrap,
 * with one roving tab stop, matching the previous control.
 */
export function ThemeSwitch({ className, compact = false }: { className?: string; compact?: boolean }) {
  const theme = useThemePreference();
  return (
    <div role="radiogroup" aria-label="外观" className={cn("grid gap-0.5 rounded-md bg-sidebar-accent p-0.5", compact ? "grid-cols-1" : "grid-cols-3", className)}>
      {themeChoices.map((option, index) => {
        const Icon = icons[option.value];
        const checked = theme === option.value;
        return (
          <button key={option.value} type="button" role="radio" aria-checked={checked} aria-label={option.label} title={option.title}
            tabIndex={checked ? 0 : -1}
            className={cn("flex h-7 items-center justify-center gap-1.5 rounded-[4px] text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
              checked && "bg-card font-medium text-foreground shadow-xs dark:bg-input/60")}
            onClick={() => selectTheme(option.value)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const next = (index + (event.key === "ArrowLeft" ? 2 : 1)) % themeChoices.length;
              selectTheme(themeChoices[next].value);
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[next].focus();
            }}>
            <Icon aria-hidden="true" className="size-3.5" />
            <span className={compact ? "sr-only" : undefined}>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
