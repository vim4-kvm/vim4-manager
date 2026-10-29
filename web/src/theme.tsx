import { useSyncExternalStore } from "react";
import { t } from "./i18n";

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

/** Labels shared by every appearance control. */
export const themeChoices: { value: Theme; label: string; title: string }[] = [
  { value: "light", get label() { return t("theme.light"); }, get title() { return t("theme.light"); } },
  { value: "dark", get label() { return t("theme.dark"); }, get title() { return t("theme.dark"); } },
  { value: "system", get label() { return t("theme.system"); }, get title() { return t("theme.system"); } },
];
