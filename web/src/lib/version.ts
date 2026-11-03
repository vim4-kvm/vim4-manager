const DEVELOPMENT = /\.dev\.\d+\.g[0-9a-f]{7,40}(?:\.dirty)?$/;

export function isDevelopmentVersion(version: string): boolean {
  return DEVELOPMENT.test(version);
}

/** The released base of a development build, for compact display. */
export function baseVersion(version: string): string {
  return version.replace(DEVELOPMENT, "");
}

const KERNEL_VERSION = /^\d+(?:\.\d+)*/;
const KERNEL_BUILD = /-vim4-(\d{4})(\d{2})(\d{2})(?:\.\d+)?$/;

/** Upstream version and, for `-vim4-YYYYMMDD[.N]` builds, the build date (YYYY-MM-DD). */
export function kernelRelease(release: string): { version: string; buildDate?: string } {
  const version = KERNEL_VERSION.exec(release)?.[0] ?? release;
  const build = KERNEL_BUILD.exec(release);
  return build ? { version, buildDate: `${build[1]}-${build[2]}-${build[3]}` } : { version };
}
