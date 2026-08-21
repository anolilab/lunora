/**
 * Whether a KEY NAME implies its value is a secret (`API_KEY`, `apiToken`,
 * `db_password`) rather than plain config (`PORT`, `DATABASE_URL`).
 *
 * One rule, four call sites that must agree or the product contradicts itself:
 * `@lunora/server`'s `redactSecrets` (what gets masked in a log), the
 * `.dev.vars` scaffolder in `@lunora/config` (what gets a freshly minted random
 * value), `lunora deploy` (which secrets the deployed worker is expected to
 * carry) and `lunora doctor` (which placeholders are reported unset). It lived
 * as four copied regexes kept in step by a comment, and they drifted: two were
 * updated to match camelCase keys and two were not, so `apiToken` in a
 * `.dev.vars` was a secret to the runtime and ordinary config to the CLI.
 *
 * It lives in `shared/` rather than in any one package because
 * `@lunora/server` (the app runtime) must not take a build/CLI-layer dependency
 * on `@lunora/config`, and vice versa. Inlined by the bundler, so there is one
 * definition and no dependency edge.
 *
 * # The rule
 *
 * The name ends in key / password / secret / token, case-insensitively, so
 * every convention a key actually arrives in is covered: SCREAMING_SNAKE
 * (`API_KEY`), no-separator caps (`OPENAI_APIKEY`), snake or kebab (`api_key`,
 * `auth-token`), Title case (`Api_Key`), camelCase (`apiToken`) and bare
 * (`password`). Anchored at the END, so `SECRETARY` is not a secret.
 *
 * Two deliberate consequences:
 *
 *   - **Over-redaction is accepted.** `sortKey` / `idempotencyKey` are treated
 *     as secrets. Masking a non-secret costs a line of diagnostic text; missing
 *     a secret costs the secret.
 *   - **Ordinary English words ending in "key" are excluded** by name
 *     ({@link ORDINARY_KEY_WORD}) — `MONKEY=banana` is not a credential. This
 *     has to be a word list: `MONKEY` and `APIKEY` are structurally identical
 *     (all-caps compound, suffix at the end, no separator), so no boundary rule
 *     can separate them. Requiring a separator instead was tried and silently
 *     un-redacted `OPENAI_APIKEY`, `APITOKEN` and `MYPASSWORD`.
 *
 * Adding a suffix (say `credential`) means adding it here, plus a case in each
 * consumer's suite — never a fifth private copy.
 */

/** The four secret-implying suffixes, at the end of the name, in any casing. */
const SECRET_SUFFIX = /(?:key|password|secret|token)$/iu;

/**
 * Ordinary words ending in "key" — the only false-positive class the suffix
 * rule has, since nothing innocuous ends in password/secret/token.
 */
const ORDINARY_KEY_WORD = /(?:don|flun|hoc|joc|lac|malar|mic|mon|tur|whis)key$/iu;

/**
 * Whether the key's NAME implies a secret value.
 * @param key the key name (env var, `.dev.vars` key, or a `key=value` capture).
 * @returns `true` when the name ends in a secret-implying suffix.
 */
const isSecretKeyName = (key: string): boolean => SECRET_SUFFIX.test(key) && !ORDINARY_KEY_WORD.test(key);

export { isSecretKeyName };
