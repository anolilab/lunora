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
 * The name ends in key / password / secret / token, case-insensitively,
 * **whatever precedes it**. That covers every convention a key actually
 * arrives in — SCREAMING_SNAKE (`API_KEY`), no-separator caps
 * (`OPENAI_APIKEY`), snake or kebab (`api_key`, `auth-token`), Title case
 * (`Api_Key`), camelCase (`apiToken`) and bare (`password`) — and it is
 * anchored at the END, so `SECRETARY` is not a secret.
 *
 * # Over-redaction is the deliberate failure direction
 *
 * `MONKEY`, `sortKey` and `idempotencyKey` are treated as secrets. That is the
 * chosen trade: masking a non-secret costs one confusing line of diagnostic
 * text, missing `APITOKEN` costs the credential. The two are not separable by
 * any positional rule — `MONKEY` and `APIKEY` are structurally identical
 * (all-caps compound, suffix at the end, no separator) — and requiring a
 * separator instead was tried and silently un-redacted `OPENAI_APIKEY`,
 * `APITOKEN` and `MYPASSWORD`. Excluding ordinary words by name was tried too
 * and is a trap: any such list is unbounded and instantly incomplete
 * (`turnkey`, `hokey`, `lowkey`, `smokey` all end in "key"), so it buys the
 * appearance of precision and none of the property.
 *
 * The consumer that WRITES rather than logs is safe under over-matching too:
 * the scaffolder mints a value only where the example held a placeholder, so
 * an over-match at worst fills a placeholder the user had to fill anyway — it
 * never overwrites a real value.
 *
 * Adding a suffix (say `credential`) means adding it here, plus a case in each
 * consumer's suite — never a fifth private copy.
 */

/** The four secret-implying suffixes, at the end of the name, in any casing. */
const SECRET_SUFFIX = /(?:key|password|secret|token)$/iu;

/**
 * Whether the key's NAME implies a secret value.
 * @param key the key name (env var, `.dev.vars` key, or a `key=value` capture).
 * @returns `true` when the name ends in a secret-implying suffix.
 */
const isSecretKeyName = (key: string): boolean => SECRET_SUFFIX.test(key);

export { isSecretKeyName };
