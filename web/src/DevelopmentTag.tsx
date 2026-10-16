export function isDevelopmentVersion(version: string): boolean {
  return /\.dev\.\d+\.g[0-9a-f]{7,40}(?:\.dirty)?$/.test(version);
}

export function DevelopmentTag({ version }: { version: string }) {
  if (!isDevelopmentVersion(version)) return null;
  return <span className="tag development-tag" title={version.endsWith(".dirty") ? "包含未提交的源码修改" : "从已提交源码构建的开发版"}>开发版</span>;
}
