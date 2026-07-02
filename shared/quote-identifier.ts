/**
 * Canonical SQL identifier quoter shared by `@lunora/d1` and `@lunora/do`.
 *
 * Double-quotes a SQL identifier and escapes any embedded double quotes by
 * doubling them (`"` → `""`) — the ANSI/SQLite/Postgres rule. This is a
 * security-relevant primitive (it is the sole defense against identifier
 * injection wherever a table/column name is spliced into raw SQL), so it must
 * have exactly ONE definition rather than byte-identical copies that can drift.
 *
 * Like `shared/stable-key.ts`, it is deliberately **not** a package: `@lunora/d1`
 * and `@lunora/do` sit on the same tier with no lower-level package to host it,
 * so each imports this file by relative path and the bundler (packem/rollup)
 * inlines it — no runtime dependency edge, duplicated only in emitted output.
 * Keep it genuinely zero-dependency (relative/built-in imports only) or inlining
 * breaks. Consumers must drop `outDir`/`rootDir` from their `tsconfig.json` (a
 * set `rootDir` raises TS6059 for this out-of-package file under `tsc --noEmit`).
 */
export const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;
