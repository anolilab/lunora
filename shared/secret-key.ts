/**
 * Whether a KEY NAME implies its value is a secret (`API_KEY`, `apiToken`,
 * `db_password`) rather than plain config (`PORT`, `DATABASE_URL`,
 * `PARTITION_KEY`).
 *
 * One rule, five call sites that must agree or the product contradicts itself:
 * `@lunora/server`'s `redactValueForKey` (what gets masked in a thrown env
 * error), the `.dev.vars` scaffolder in `@lunora/config` (what gets a freshly
 * minted random value), `@lunora/config`'s wrangler `vars` scanner (what the
 * `plaintext_secret_in_wrangler_vars` advisor flags), `lunora deploy` (which
 * secrets the deployed worker is expected to carry) and `lunora doctor` (which
 * placeholders are reported unset). It lived as copied regexes kept in step by a
 * comment, and they drifted every time: first two of four were taught camelCase
 * and two were not, then the wrangler scanner grew a materially richer rule
 * under the same function name — so `SENTRY_DSN` was a secret to the advisor and
 * ordinary config to `lunora deploy`, which let a non-interactive deploy succeed
 * against a worker that then crashed on the missing secret, while
 * `STRIPE_PUBLISHABLE_KEY` blocked a deploy as a missing "secret".
 *
 * It lives in `shared/` rather than in any one package because
 * `@lunora/server` (the app runtime) must not take a build/CLI-layer dependency
 * on `@lunora/config`, and vice versa. Inlined by the bundler, so there is one
 * definition and no dependency edge.
 *
 * # The rule
 *
 * The name is split into words on `_`, `-` **and camelCase boundaries**, so
 * every convention a key actually arrives in normalizes to the same tokens —
 * SCREAMING_SNAKE (`API_KEY`), snake or kebab (`api_key`, `auth-token`), Title
 * case (`Api_Key`) and camelCase (`apiToken`) all become `API` + `KEY` /
 * `TOKEN`. A name is a secret when:
 *
 * 1. any word is a secret word on its own ({@link SECRET_WORD_TOKENS}:
 *    `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PASSPHRASE`, `DSN`,
 *    `CREDENTIAL`) — so `AUTH_TOKEN` hits and `TOKENIZER` / `SECRETARY` do
 *    not; or
 * 2. the normalized name ends in a compound secret-bearing key suffix
 *    ({@link SECRET_KEY_SUFFIXES}: `API_KEY`, `ACCESS_KEY`, `PRIVATE_KEY`,
 *    `SIGNING_KEY`, `ENCRYPTION_KEY`); or
 * 3. the raw name ends in one of the unambiguous run-together forms
 *    ({@link SECRET_TAIL}) that no word split can recover — `APITOKEN`,
 *    `MYPASSWORD`, `OPENAI_APIKEY`.
 *
 * Each of the three is checked against the {@link singular} of what it matches,
 * so a PLURAL is not a separate spelling to remember: `TOKENS`, `API_KEYS` and
 * `MYPASSWORDS` classify exactly as their singulars do. The list used to carry
 * `CREDENTIALS` beside `CREDENTIAL` and nothing else, so every other plural —
 * `SECRETS`, `TOKENS`, `PASSWORDS`, `API_KEYS`, `PRIVATE_KEYS`, `SIGNING_KEYS` —
 * read as ordinary config, and `TOKENS=<value>` reached a thrown env error in
 * the clear.
 *
 * …unless the name advertises itself as public ({@link isPublicKeyName}:
 * `PUBLIC` / `PUBLISHABLE`), which wins: `NEXT_PUBLIC_API_KEY` and
 * `STRIPE_PUBLISHABLE_KEY` are meant to ship in cleartext.
 *
 * # Bare `KEY` is deliberately NOT a secret
 *
 * `PARTITION_KEY`, `IDEMPOTENCY_KEY`, `sortKey` and `MONKEY` are ordinary
 * config. An earlier suffix-only rule (`/(key|password|secret|token)$/i`)
 * treated all four as secrets and defended it as harmless over-redaction — but
 * the deploy pre-flight is not a log line: it turns a "secret" into a *required*
 * secret and refuses a non-interactive deploy without it, so over-matching there
 * blocks a correct deploy. The words above are specific enough not to need the
 * bare suffix, and `SECRET_TAIL` covers the run-together forms it existed for.
 *
 * Adding a word (say `apikey` under a new spelling) means adding it here, plus a
 * case in each consumer's suite — never a private copy.
 */

/**
 * `TOKENS` -> `TOKEN`. A single trailing `S` is dropped so each word list below
 * is written in the singular and matches both numbers; a word that is not a
 * plural of anything in those lists is unchanged by it in the ways that matter
 * (`ACCESS` -> `ACCES` matches nothing either way).
 */
const singular = (word: string): string => (word.endsWith("S") ? word.slice(0, -1) : word);

/** Split a key on `_` / `-` / camelCase boundaries and upper-case the words. */
const keyWords = (key: string): string[] =>
    key
        .replaceAll(/([a-z\d])([A-Z])/gu, "$1_$2")
        .toUpperCase()
        .split(/[_-]+/u)
        .filter((word) => word.length > 0);

/**
 * Whole words that, standing alone in a key, denote a secret payload. Matched
 * against a split word exactly, so `TOKEN` hits `AUTH_TOKEN` but not
 * `TOKENIZER`, and `SECRET` hits `WEBHOOK_SECRET` but not `SECRETARY`.
 */
const SECRET_WORD_TOKENS: ReadonlySet<string> = new Set(["CREDENTIAL", "DSN", "PASSPHRASE", "PASSWD", "PASSWORD", "SECRET", "TOKEN"]);

/**
 * Compound `*_KEY` names that ARE secret-bearing (unlike a bare `KEY`). Matched
 * as the whole normalized key or a trailing `_`-delimited suffix, so
 * `OPENAI_API_KEY` hits `API_KEY`.
 */
const SECRET_KEY_SUFFIXES: ReadonlyArray<string> = ["ACCESS_KEY", "API_KEY", "ENCRYPTION_KEY", "PRIVATE_KEY", "SIGNING_KEY"];

/**
 * Run-together spellings no word split can recover (`APITOKEN`, `MYPASSWORD`,
 * `OPENAI_APIKEY`, `MY_PRIVATEKEY`), with an optional plural `S`.
 *
 * DERIVED from the two lists above rather than written out again: this used to be
 * a third hand-maintained spelling of the same vocabulary and it drifted from
 * both — it carried `apikey` but not `privatekey`/`signingkey`, so `MY_APIKEY`
 * was a secret and `MY_PRIVATEKEY` was not. Every source entry is a word that
 * does not appear as the tail of an ordinary English compound, which is why bare
 * `key` is absent from both lists — `MONKEY` and `APIKEY` are otherwise
 * structurally identical, and only the COMPOUND `*_KEY` suffixes contribute a
 * `…key` tail here.
 */
const SECRET_TAIL = new RegExp(`(?:${[...SECRET_WORD_TOKENS, ...SECRET_KEY_SUFFIXES.map((suffix) => suffix.replaceAll("_", ""))].join("|")})S?$`, "iu");

/**
 * Whole words marking a key as public/publishable — meant to ship in cleartext
 * (Stripe `pk_…`, Supabase anon keys, `NEXT_PUBLIC_*`), so exempt from
 * {@link isSecretKeyName} even when the rest of the name looks secret.
 * @param key the key name.
 * @returns `true` when the name advertises a public value.
 */
const isPublicKeyName = (key: string): boolean => keyWords(key).some((word) => word === "PUBLIC" || word === "PUBLISHABLE");

/**
 * Whether the key's NAME implies a secret value.
 * @param key the key name (env var, `.dev.vars` key, or a `key=value` capture).
 * @returns `true` when the name implies a secret and does not advertise itself as public.
 */
const isSecretKeyName = (key: string): boolean => {
    if (isPublicKeyName(key)) {
        return false;
    }

    const words = keyWords(key);

    if (words.some((word) => SECRET_WORD_TOKENS.has(singular(word)))) {
        return true;
    }

    // The normalized name ends with its last word, so dropping ONE trailing `S`
    // off the whole string de-pluralizes exactly that word: `API_KEYS` -> `API_KEY`.
    const normalized = singular(words.join("_"));

    return SECRET_KEY_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(`_${suffix}`)) || SECRET_TAIL.test(key);
};

export { isPublicKeyName, isSecretKeyName };
