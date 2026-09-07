/**
 * Canonical reader for the boolean-ish `LUNORA_*` deployment env flags
 * (`LUNORA_SECURITY_HEADERS`, `LUNORA_SECURITY_CSRF`,
 * `LUNORA_CORS_ALLOW_CREDENTIALS`, …).
 *
 * Three layers read the SAME variables and must agree on what "on" and "off"
 * spell, or the disagreement ships: `@lunora/config`'s wrangler validator green-
 * lights a `vars` block at build time, `@lunora/runtime`'s `resolveSecurity`
 * acts on it at request time, and `@lunora/observability`'s security audit
 * reports on it. Each had its own copy of the token sets — the validator's
 * comment even said it "mirrors the DO security audit", which is a drift hazard
 * written down rather than fixed.
 *
 * Note the two sets are NOT complements and neither is exhaustive: an env var
 * that is absent, empty, or spelled some other way is neither enabled nor
 * disabled, and callers fall back to their code-level default. That three-state
 * behaviour is why these are predicates rather than a single `parseBoolean`.
 *
 * The `enabled` / `disabled` spellings are specific to this family. `@lunora/
 * server`'s `v.boolean()` env coercion and `@lunora/flags`' env provider
 * deliberately accept only `1/on/true/yes` and `0/false/no/off`, because there a
 * value that is neither is a user-facing parse ERROR rather than a fallback —
 * widening those would silently accept typos. Do not fold them in here.
 *
 * Like the sibling `shared/*` helpers this is deliberately **not** a package:
 * the three consumers sit on different tiers with no common lower-level home, so
 * each imports this file by relative path and the bundler (packem/rollup)
 * inlines it — no runtime dependency edge. Keep it genuinely zero-dependency
 * (relative/built-in imports only) or inlining breaks. Consumers must drop
 * `outDir`/`rootDir` from their `tsconfig.json` (a set `rootDir` raises TS6059
 * for this out-of-package file under `tsc --noEmit`).
 */

/** Env values that read as "turn this layer off". */
const DISABLED_ENV_VALUES: ReadonlySet<string> = new Set(["0", "disabled", "false", "no", "off"]);

/** Env values that read as "turn this on". */
const ENABLED_ENV_VALUES: ReadonlySet<string> = new Set(["1", "enabled", "on", "true", "yes"]);

/** True when an env var is explicitly set to a disable value (`off`, `false`, `0`, …). Absent/unrecognised → `false`. */
const isEnvDisabled = (value: unknown): boolean => typeof value === "string" && DISABLED_ENV_VALUES.has(value.trim().toLowerCase());

/** True when an env var is explicitly set to an enable value (`on`, `true`, `1`, …). Absent/unrecognised → `false`. */
const isEnvEnabled = (value: unknown): boolean => typeof value === "string" && ENABLED_ENV_VALUES.has(value.trim().toLowerCase());

export { isEnvDisabled, isEnvEnabled };
