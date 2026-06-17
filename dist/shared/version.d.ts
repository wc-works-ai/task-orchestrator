/**
 * The application version, read from `package.json`. The `read` function is
 * injectable so tests can exercise the parse/fallback branches without touching
 * the filesystem; the default resolves the repo-root `package.json` from both
 * `src/shared/` (vitest) and `dist/shared/` (built). Any read or parse failure
 * yields the meaningful fallback `'unknown'`.
 */
export declare function appVersion(read?: () => string): string;
