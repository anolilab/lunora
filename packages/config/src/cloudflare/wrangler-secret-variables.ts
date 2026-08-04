/**
 * Scans a project's `wrangler.jsonc` `vars` block for plaintext secrets — the
 * evidence producer behind the advisor's `plaintext_secret_in_wrangler_vars` lint.
 *
 * `vars` are Wrangler's **plaintext** environment variables: they are baked into
 * the deployed Worker in cleartext AND `wrangler.jsonc` is committed to source
 * control, so a real key/token/private-key placed there leaks two ways at once.
 * This lives in `@lunora/config` (the only layer that reads `wrangler.jsonc`) and
 * reuses the exact secret-shape heuristics `@lunora/codegen` applies to source
 * literals ({@link secretKindOf}), so the two secret lints never diverge. The raw
 * value never leaves this module — only a {@link redact}ed preview crosses into the
 * IR.
 */
import { relative } from "node:path";

import type { WranglerVariableIR } from "@lunora/codegen";
import { redact, secretKindOf } from "@lunora/codegen";

import { isPlaceholderValue } from "../scaffold-dev-variables";
import { findWranglerFile, readWranglerJsonc } from "./wrangler-path";

/** Only the slice of the wrangler config this scanner needs (`vars` mirrors wrangler's literal key). */
interface WranglerVariablesShape {
    vars?: Record<string, unknown>;
}

/**
 * A secret value shorter than this is almost always benign config (a version tag,
 * a small number-as-string, `"true"`), so the key-name-only heuristic ignores it —
 * the shape heuristic ({@link secretKindOf}) already has its own length floors and
 * is not gated by this.
 */
const MIN_SECRET_NAMED_VALUE_LENGTH = 8;

/**
 * Whole-word tokens that, standing alone in a key, denote a secret payload. Split
 * a key on `_`/`-` and match a token exactly, so `TOKEN` hits `AUTH_TOKEN` but not
 * `TOKENIZER`, and `SECRET` hits `WEBHOOK_SECRET` but not `SECRETARY`. Bare `KEY`
 * is intentionally absent — it's too broad (`PARTITION_KEY`, `IDEMPOTENCY_KEY`).
 */
const SECRET_WORD_TOKENS = new Set(["CREDENTIAL", "CREDENTIALS", "DSN", "PASSPHRASE", "PASSWD", "PASSWORD", "SECRET", "TOKEN"]);

/**
 * Compound `*_KEY` names that ARE secret-bearing (unlike a bare `KEY`). Matched as
 * a whole key or a trailing `_`-delimited suffix, so `OPENAI_API_KEY` hits `API_KEY`.
 */
const SECRET_KEY_SUFFIXES = ["ACCESS_KEY", "API_KEY", "ENCRYPTION_KEY", "PRIVATE_KEY", "SIGNING_KEY"];

/**
 * Whole-word tokens marking a key as public/publishable — meant to ship in
 * cleartext (Stripe `pk_…`, Supabase anon keys, `NEXT_PUBLIC_*`), so exempt even
 * when the value is high-entropy, otherwise the rule would nag on every public key.
 */
const PUBLIC_KEY_TOKENS = new Set(["PUBLIC", "PUBLISHABLE"]);

/** Splits a key on its `_`/`-` word separators. */
const KEY_SEPARATOR_RE = /[_-]/u;

/** Uppercase a key and split it into its `_`/`-`-delimited tokens. */
const keyTokens = (key: string): string[] => key.toUpperCase().split(KEY_SEPARATOR_RE);

/** True when the key name strongly implies a secret payload (and isn't a public key). */
const isSecretKeyName = (key: string): boolean => {
    const normalized = key.toUpperCase().replaceAll("-", "_");

    if (keyTokens(key).some((token) => SECRET_WORD_TOKENS.has(token))) {
        return true;
    }

    return SECRET_KEY_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(`_${suffix}`));
};

/** True when the key advertises itself as a public/publishable value (exempt from the rule). */
const isPublicKeyName = (key: string): boolean => keyTokens(key).some((token) => PUBLIC_KEY_TOKENS.has(token));

/**
 * Pure scan of a `vars` map for plaintext secrets — the FS-free core, exported for
 * unit tests. A variable is flagged when, for a **string** value that is neither a
 * placeholder nor a public/publishable key, EITHER the value matches a known
 * secret shape (`secretKindOf`) OR the key name strongly implies a secret and the
 * value is long enough to plausibly be one. `kind` is the matched shape, or
 * `secret_named_var` for the key-name path.
 */
const scanWranglerVariablesForSecrets = (variables: Record<string, unknown> | undefined, file: string): WranglerVariableIR[] => {
    if (variables === undefined) {
        return [];
    }

    const findings: WranglerVariableIR[] = [];

    for (const [key, rawValue] of Object.entries(variables)) {
        // Only string values can be a plaintext secret; wrangler folds numbers /
        // booleans / JSON objects into typed vars that this heuristic ignores.
        if (typeof rawValue !== "string") {
            continue;
        }

        // A fill-me-in placeholder (`<your-key>`, `changeme`, …) is not a real
        // secret — regenerated/filled locally, never a live credential.
        if (isPlaceholderValue(rawValue)) {
            continue;
        }

        // Public/publishable keys are meant to be shipped in cleartext.
        if (isPublicKeyName(key)) {
            continue;
        }

        const shapeKind = secretKindOf(rawValue);
        const kind = shapeKind ?? (isSecretKeyName(key) && rawValue.length >= MIN_SECRET_NAMED_VALUE_LENGTH ? "secret_named_var" : undefined);

        if (kind === undefined) {
            continue;
        }

        findings.push({ file, key, kind, preview: redact(rawValue) });
    }

    return findings;
};

/**
 * Read the project's `wrangler.jsonc` and return its plaintext-secret `vars` as IR
 * for the `plaintext_secret_in_wrangler_vars` lint. Returns `[]` when there is no
 * wrangler config, it doesn't parse, or nothing looks like a secret. Scans the
 * top-level `vars` block (mirroring the existing `validateCorsVariables` scope);
 * per-environment `env.<name>.vars` overrides are out of scope for now.
 */
const collectWranglerSecretVariables = (projectRoot: string): WranglerVariableIR[] => {
    const wranglerPath = findWranglerFile(projectRoot);

    if (wranglerPath === undefined) {
        return [];
    }

    const { parsed } = readWranglerJsonc<WranglerVariablesShape>(wranglerPath);

    if (parsed === undefined) {
        return [];
    }

    return scanWranglerVariablesForSecrets(parsed.vars, relative(projectRoot, wranglerPath));
};

export { collectWranglerSecretVariables, scanWranglerVariablesForSecrets };
