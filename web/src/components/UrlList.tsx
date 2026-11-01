import { Fragment } from "react";
import { CopyButton } from "@/components/CopyButton";
import { t } from "@/i18n";

export interface UrlRow {
  label: string;
  url: string;
}

/** URL pieces that may sit on separate lines: scheme, host, then port and path. */
export function urlParts(url: string): string[] {
  const match = /^([a-z]+:\/\/)(\[[^\]]+\]|[^/:]+)(.*)$/i.exec(url);
  return match ? match.slice(1).filter(Boolean) : [url];
}

/**
 * Labelled URLs with copy buttons. Narrow screens put the label above the URL,
 * which wraps only after `://` or before `:port`, never inside a host or IP.
 */
export function UrlList({ rows }: { rows: UrlRow[] }) {
  return (
    <ul className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 rounded-lg bg-muted/50 p-3 max-sm:grid-cols-[minmax(0,1fr)_auto] sm:w-fit">
      {rows.map(({ label, url }) => (
        <li key={url} className="col-span-full grid grid-cols-subgrid items-center gap-y-0.5">
          <span className="text-xs text-muted-foreground max-sm:col-span-full">{label}</span>
          <a className="font-mono" href={url} target="_blank" rel="noreferrer noopener">
            {urlParts(url).map((part, i) => <Fragment key={i}>{i > 0 && <wbr />}<span className="whitespace-nowrap">{part}</span></Fragment>)}
          </a>
          <span className="justify-self-start"><CopyButton text={url} label={t("tailscale.url", { p0: label })} /></span>
        </li>
      ))}
    </ul>
  );
}
