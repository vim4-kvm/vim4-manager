import { Badge } from "@/components/ui/badge";
import { isDevelopmentVersion } from "@/lib/version";
import { useT } from "@/i18n";

export function DevelopmentBadge({ version }: { version: string }) {
  const t = useT();
  if (!isDevelopmentVersion(version)) return null;
  return (
    <Badge variant="secondary" className="h-[18px] rounded-sm px-1.5 font-normal"
      title={version.endsWith(".dirty") ? t("updates.dirty") : t("updates.clean")}>
      {t("updates.development")}
    </Badge>
  );
}
