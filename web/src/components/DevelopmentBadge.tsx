import { Badge } from "@/components/ui/badge";
import { isDevelopmentVersion } from "@/lib/version";

export function DevelopmentBadge({ version }: { version: string }) {
  if (!isDevelopmentVersion(version)) return null;
  return (
    <Badge variant="secondary" className="h-[18px] rounded-sm px-1.5 font-normal"
      title={version.endsWith(".dirty") ? "包含未提交的源码修改" : "从已提交源码构建的开发版"}>
      开发版
    </Badge>
  );
}
