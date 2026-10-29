import { getLocale } from ".";

export function number(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(getLocale(), options).format(value);
}
export function dateTime(value: number | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(getLocale(), {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", ...options,
  }).format(value);
}
export function time(value: number | Date): string {
  return new Intl.DateTimeFormat(getLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(value);
}
export function relativeTime(value: number, unit: Intl.RelativeTimeFormatUnit): string {
  return new Intl.RelativeTimeFormat(getLocale(), { style: getLocale() === "en" ? "long" : "short" }).format(value, unit);
}
export function durationPart(value: number, unit: "day" | "hour" | "minute"): string {
  return number(value, { style: "unit", unit, unitDisplay: getLocale() === "en" ? "short" : "long" }).replace(getLocale() === "en" ? /$^/ : /\s/g, "");
}
export function bytes(value: number): string {
  const index = Math.min(4, Math.max(0, Math.floor(Math.log10(Math.max(1, value)) / 3)));
  return `${number(value / 1000 ** index, { maximumFractionDigits: index ? 1 : 0 })} ${["B", "kB", "MB", "GB", "TB"][index]}`;
}
