import { isDevelopmentVersion } from "./lib/version";

export { isDevelopmentVersion };

export function DevelopmentTag({ version }: { version: string }) {
  if (!isDevelopmentVersion(version)) return null;
  return <span className="tag development-tag" title={version.endsWith(".dirty") ? "包含未提交的源码修改" : "从已提交源码构建的开发版"}>开发版</span>;
}
