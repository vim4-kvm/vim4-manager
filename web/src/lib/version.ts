const DEVELOPMENT = /\.dev\.\d+\.g[0-9a-f]{7,40}(?:\.dirty)?$/;

export function isDevelopmentVersion(version: string): boolean {
  return DEVELOPMENT.test(version);
}

/** The released base of a development build, for compact display. */
export function baseVersion(version: string): string {
  return version.replace(DEVELOPMENT, "");
}
