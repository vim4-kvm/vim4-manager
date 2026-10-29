import type { en } from "./en";

export type Key = keyof typeof en;
type Params<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? P | Params<Rest> : never;
type Text<V> = V extends string ? V : V extends { other: infer S extends string } ? S : never;
export type MessageParams<K extends Key> = Params<Text<(typeof en)[K]>>;
type SameParams<Source extends string, Translation extends string> =
  [Params<Source>] extends [Params<Translation>]
    ? [Params<Translation>] extends [Params<Source>] ? Translation : never : never;
type Translation<V, T> = V extends string
  ? T extends string ? SameParams<V, T> : never
  : V extends { one: infer One extends string; other: infer Other extends string }
    ? T extends { one: infer A extends string; other: infer B extends string }
      ? { one: SameParams<One, A>; other: SameParams<Other, B> } : never : never;

/** Keep literal types so missing, extra and changed placeholder names fail tsc. */
export function defineCatalog<const T extends Record<Key, string | { one: string; other: string }>>(
  catalog: T & Record<Exclude<keyof T, Key>, never> & { [K in Key]: Translation<(typeof en)[K], T[K]> },
): T { return catalog; }
