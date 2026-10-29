import { useSyncExternalStore } from "react";
import { en } from "./en";
import type { Key, MessageParams } from "./catalog";

export type Locale = "en" | "zh-CN";
export const languageChoices = [
  { value: "en", label: "English" },
  { value: "zh-CN", label: "简体中文" },
] as const;
const storageKey = "vim4-manager-language";
type Catalog = { [K in Key]: string | { one: string; other: string } };
const catalogs: Partial<Record<Locale, Catalog>> = { en };
let chineseCatalog: Promise<void> | undefined;
function loadCatalog(value: Locale): Promise<void> | undefined {
  if (value === "en" || catalogs[value]) return;
  return chineseCatalog ??= import("./zh-CN").then(({ zhCN }) => { catalogs["zh-CN"] = zhCN; }).catch(error => { chineseCatalog = undefined; throw error; });
}
const listeners = new Set<() => void>();

function readLocale(): Locale {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === "en" || saved === "zh-CN") return saved;
  } catch { /* Private browsing can disable storage. */ }
  return navigator.languages?.some((language) => /^zh/i.test(language)) ? "zh-CN" : "en";
}

let locale: Locale = "en";
let selection = 0;
export async function initializeLocale() { await changeLocale(readLocale()); }
export function getLocale(): Locale { return locale; }

function applyLocale() {
  document.documentElement.lang = locale;
  document.cookie = `vim4_lang=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
applyLocale();

function notify() {
  applyLocale();
  listeners.forEach((listener) => listener());
}
function onStorage(event: StorageEvent) {
  if (event.key !== storageKey && event.key !== null) return;
  void changeLocale(readLocale());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", onStorage);
  };
}
async function changeLocale(value: Locale, persist = false) {
  const request = ++selection;
  const pending = loadCatalog(value);
  if (pending) await pending;
  if (request !== selection) return;
  locale = value;
  if (persist) try { localStorage.setItem(storageKey, value); } catch { /* Keep this tab usable. */ }
  notify();
}
export function selectLocale(value: Locale) { return changeLocale(value, true); }
export function useLocale(): Locale { return useSyncExternalStore(subscribe, getLocale); }

export function t<K extends Key>(key: K, ...args: [MessageParams<K>] extends [never]
  ? [] : [params: Record<MessageParams<K>, string | number>]): string {
  const params = args[0] as Record<string, string | number> | undefined;
  const entry = catalogs[locale]![key];
  const text = typeof entry === "string" ? entry
    : entry[new Intl.PluralRules(locale).select(Number(params?.count)) === "one" ? "one" : "other"];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params?.[name];
    return typeof value === "number" ? new Intl.NumberFormat(locale).format(value) : value ?? `{${name}}`;
  });
}
export function useT(): typeof t { useLocale(); return t; }
