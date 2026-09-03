import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Security-shaped key tokens naming a *protection* the flag toggles on
 * (restriction / guard semantics). The fail-open-safe default for these is
 * `true` (the protection stays on during a provider outage), so a `false`
 * default is unsafe.
 */
const PROTECT_TOKENS = new Set(["disallow", "disallowed", "enforce", "enforced", "enforcement", "enforcing", "gate", "gated", "gating", "lockdown", "rls"]);

/**
 * Security-shaped key tokens naming a *permission or bypass* the flag grants. The
 * fail-open-safe default for these is `false` (nothing is granted during a
 * provider outage), so a `true` default is unsafe.
 */
const PERMIT_TOKENS = new Set(["allow", "allowed", "bypass", "bypassed", "permit", "permitted"]);

/**
 * Tokens that INVERT the key's polarity: they name turning the protection (or
 * the permission) *off* rather than on.
 *
 * Without this, the whole kill-switch family is scored backwards.
 * `ctx.flags.boolean("disableRls", true)` — RLS off for every request once the
 * provider is unreachable — tokenizes to `["disable", "rls"]`, `rls` is a
 * protect token, and a protect key defaulting `true` reads as safe: zero
 * findings on the dangerous spelling, while the safe `disableRls: false` was
 * flagged with a remediation telling the user to set it `true`.
 *
 * `disallow*` is deliberately NOT here: it names a restriction outright, so it
 * scores as a protection token above (`disallowUploads: false` means uploads are
 * allowed on an outage — unsafe, same as any protect key defaulting `false`).
 */
const NEGATION_TOKENS = new Set(["disable", "disabled", "no", "off", "skip", "skipped", "without"]);

/**
 * Zero-width boundary between an acronym's last letter and a following
 * CapitalizedWord (`RLSEnabled` → `RLS Enabled`). A lookaround (no backtracking
 * quantifier) keeps the split linear.
 */
const ACRONYM_WORD_BOUNDARY = /(?<=[A-Z])(?=[A-Z][a-z])/gu;

/** Zero-width boundary at a camelCase hump (`enforceRls` → `enforce Rls`). */
const CAMEL_HUMP_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])/gu;

/** A run of non-alphanumeric characters separating tokens (`bypass_auth` → `bypass`, `auth`). */
const NON_ALPHANUMERIC_RUN = /[^a-z0-9]+/u;

/**
 * Split a flag key into lowercased word tokens across camelCase and
 * non-alphanumeric boundaries (`enforceRls` → `["enforce", "rls"]`,
 * `RLSEnabled` → `["rls", "enabled"]`, `bypass_auth` → `["bypass", "auth"]`).
 * Token-level (not substring) matching keeps a benign `aggregate` from matching
 * the `gate` token.
 */
const tokenize = (key: string): string[] =>
    key
        .replaceAll(ACRONYM_WORD_BOUNDARY, " ")
        .replaceAll(CAMEL_HUMP_BOUNDARY, " ")
        .toLowerCase()
        .split(NON_ALPHANUMERIC_RUN)
        .filter((token) => token.length > 0);

/**
 * The boolean default that fails CLOSED for `key`, or `undefined` when the key's
 * polarity is indeterminate.
 *
 * A key with a *protection* token (`enforce`/`rls`/`gate`/`lockdown`/`disallow`)
 * must default `true`; one with a *permission* token (`allow`/`permit`/`bypass`)
 * must default `false`. Each {@link NEGATION_TOKENS} token in the key flips that,
 * so `disableRls`/`rlsDisabled`/`skipEnforcement` must default `false` — counted
 * by parity, so a double negation (`disableSkipRls`) lands back on the
 * un-negated polarity.
 *
 * A key with neither family (a bare `auth`/`admin`) or with both is deliberately
 * indeterminate and never flagged — the lowest-false-positive subset.
 */
const safeDefaultFor = (key: string): boolean | undefined => {
    const tokens = tokenize(key);
    const isProtect = tokens.some((token) => PROTECT_TOKENS.has(token));
    const isPermit = tokens.some((token) => PERMIT_TOKENS.has(token));

    if (isProtect === isPermit) {
        return undefined;
    }

    const negated = tokens.filter((token) => NEGATION_TOKENS.has(token)).length % 2 === 1;

    return negated ? !isProtect : isProtect;
};

/**
 * Flags a `ctx.flags.boolean(key, default)` read on a security-shaped key whose
 * fail-open default selects the *permissive* branch.
 *
 * OpenFeature returns the caller-supplied default when the provider errors, so a
 * flag read is a security decision that fails to its default. When the key names
 * a protection (`enforce*`/`rls*`/`gate*`/`lockdown*`) and defaults `false`, or
 * names a permission/bypass (`allow*`/`permit*`/`bypass*`) and defaults `true`,
 * a flag-backend outage silently disables the protection or grants the
 * permission for every request. A negating token in the key
 * (`disable*`/`*Disabled`/`skip*`/`no*`) inverts that — see
 * {@link safeDefaultFor}.
 *
 * Runs only when the codegen feeder supplies flag-default evidence
 * (`context.flagSecurityDefaults`); a runtime caller flags nothing. Deliberately
 * narrow — matched on security-shaped key tokens with an unambiguous polarity
 * plus a boolean-literal default; keys whose polarity is indeterminate (a bare
 * `auth`/`admin`) or contradictory are skipped to keep the false-positive rate
 * low. One finding per read.
 */
const flagGatesSecurityWithUnsafeDefault: Lint = {
    categories: ["SECURITY"],
    description:
        "A `ctx.flags.boolean(key, default)` read on a security-shaped key has a fail-open default that selects the permissive branch. OpenFeature returns the default when the provider errors, so an outage silently disables a protection (a `false` default on an `enforce`/`rls`/`gate`/`lockdown` key) or grants a permission (a `true` default on an `allow`/`permit`/`bypass` key). A negating token in the key (`disableRls`, `rlsDisabled`, `skipEnforcement`) inverts which default is the safe one.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "flag_gates_security_with_unsafe_default",
    remediation:
        "Flip the default so a provider outage fails closed — the finding's own detail names the value to write. The safe default is always the RESTRICTIVE branch, which is not a fixed value: a protection flag (`enforce*`/`rls*`/`gate*`/`lockdown*`/`disallow*`) defaults `true` and a permission/bypass flag (`allow*`/`permit*`/`bypass*`) defaults `false`, but a negated key (`disableRls`, `rlsDisabled`, `skipEnforcement`) inverts both. Never let an unreachable flag backend open access.",
    run: (context) => {
        if (context.flagSecurityDefaults === undefined) {
            return [];
        }

        return context.flagSecurityDefaults
            .filter((row) => {
                const safeDefault = safeDefaultFor(row.key);

                return safeDefault !== undefined && safeDefault !== row.defaultValue;
            })
            .map((row) =>
                emit(flagGatesSecurityWithUnsafeDefault, {
                    cacheKey: `flag_gates_security_with_unsafe_default:${row.file}:${row.line.toString()}`,
                    detail: `\`ctx.flags.boolean("${row.key}", ${String(row.defaultValue)})\` in \`${row.exportName}\` (${row.file}:${row.line.toString()}) fails open to the permissive branch — a provider outage returns \`${String(row.defaultValue)}\`, ${row.defaultValue ? "granting the guarded permission" : "disabling the guarded protection"}. Fail closed: default it to \`${String(!row.defaultValue)}\`.`,
                    metadata: { defaultValue: row.defaultValue, exportName: row.exportName, file: row.file, key: row.key, line: row.line },
                }),
            );
    },
    source: "static",
    title: "Security flag fails open to the permissive branch",
};

export default flagGatesSecurityWithUnsafeDefault;
