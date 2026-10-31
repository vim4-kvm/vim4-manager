import { isDevelopmentVersion } from "@/lib/version";
import { useT } from "@/i18n";

export function DevelopmentBadge({ version }: { version: string }) {
  const t = useT();
  if (!isDevelopmentVersion(version)) return null;
  return (
    <span data-development-badge className="inline-flex items-center rounded-md border-0 bg-muted px-1.5 font-sans text-xs font-normal text-muted-foreground"
      title={version.endsWith(".dirty") ? t("updates.dirty") : t("updates.clean")}>
      {t("updates.development")}
    </span>
  );
}
