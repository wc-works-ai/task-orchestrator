import { readFileSync } from 'node:fs';
/**
 * The application version, read from `package.json`. The `read` function is
 * injectable so tests can exercise the parse/fallback branches without touching
 * the filesystem; the default resolves the repo-root `package.json` from both
 * `src/shared/` (vitest) and `dist/shared/` (built). Any read or parse failure
 * yields the meaningful fallback `'unknown'`.
 */
export function appVersion(read = () => readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) {
    try {
        return JSON.parse(read()).version ?? 'unknown';
    }
    catch {
        return 'unknown';
    }
}
//# sourceMappingURL=version.js.map