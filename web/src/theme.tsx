import { useSyncExternalStore, type ReactNode } from "react";

export type Theme = "light" | "dark" | "system";
const STORAGE_KEY = "vim4-manager-theme";
const media = matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();
let frame = 0;

function readTheme(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

let preference = readTheme();
let resolvedTheme: "light" | "dark" = document.documentElement.dataset.theme === "dark" ? "dark" : "light";

function applyTheme() {
  const root = document.documentElement;
  const resolved = preference === "system" ? (media.matches ? "dark" : "light") : preference;
  resolvedTheme = resolved;
  cancelAnimationFrame(frame);
  root.classList.add("theme-switching");
  root.classList.toggle("dark", resolved === "dark");
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  // Keep transitions suppressed through the frame that paints the new palette.
  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => root.classList.remove("theme-switching"));
  });
}

function syncTheme() {
  preference = readTheme();
  applyTheme();
  listeners.forEach((listener) => listener());
}

function onStorage(event: StorageEvent) {
  if (event.key === STORAGE_KEY || event.key === null) syncTheme();
}

function onSystemTheme() {
  if (preference === "system") {
    applyTheme();
    listeners.forEach((listener) => listener());
  }
}

function subscribe(listener: () => void) {
  if (!listeners.size) {
    window.addEventListener("storage", onStorage);
    media.addEventListener("change", onSystemTheme);
    syncTheme();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      window.removeEventListener("storage", onStorage);
      media.removeEventListener("change", onSystemTheme);
    }
  };
}

export function selectTheme(theme: Theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage can be disabled independently of the rest of the browser APIs.
    preference = "system";
    applyTheme();
    listeners.forEach((listener) => listener());
    return;
  }
  syncTheme();
}

export function useThemePreference(): Theme {
  return useSyncExternalStore(subscribe, () => preference);
}

export function useResolvedTheme(): "light" | "dark" {
  return useSyncExternalStore(subscribe, () => resolvedTheme);
}

const options: { value: Theme; label: string; title: string; icon: ReactNode }[] = [
  { value: "light", label: "浅色", title: "浅色", icon: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></> },
  { value: "dark", label: "深色", title: "深色", icon: <path d="M20 14a8 8 0 0 1-10-10 8.5 8.5 0 1 0 10 10Z" /> },
  { value: "system", label: "系统", title: "跟随系统", icon: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></> },
];

/** Labels shared with the migrated appearance control. */
export const themeChoices = options.map(({ value, label, title }) => ({ value, label, title }));

/** Legacy-styled switch for the login page until it migrates. */
export function ThemeSwitch({ compact = false }: { compact?: boolean }) {
  const theme = useThemePreference();
  return (
    <div className={`theme-switch${compact ? " theme-switch-compact" : ""}`} role="radiogroup" aria-label="外观">
      {options.map((option, index) => (
        <button key={option.value} type="button" role="radio" aria-checked={theme === option.value}
          aria-label={compact ? option.title : option.label} title={option.title} tabIndex={theme === option.value ? 0 : -1}
          onClick={() => selectTheme(option.value)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const next = (index + (event.key === "ArrowLeft" ? 2 : 1)) % options.length;
            selectTheme(options[next].value);
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[next].focus();
          }}>
          <svg viewBox="0 0 24 24" aria-hidden="true">{option.icon}</svg>
          {!compact && <span>{option.label}</span>}
        </button>
      ))}
    </div>
  );
}
