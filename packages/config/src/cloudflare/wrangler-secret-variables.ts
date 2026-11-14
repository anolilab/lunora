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
 *
 * The key-NAME half of the heuristic is `shared/secret-key.ts`, not a local copy.
 * This module used to carry its own richer `isSecretKeyName` under the same name
 * as the shared one, and the two disagreed on exactly the keys that matter:
 * `SENTRY_DSN` / `SMTP_PASSWD` were secrets here and plain config to
 * `lunora deploy`'s required-secrets pre-flight, while `STRIPE_PUBLISHABLE_KEY`
 * was exempt here and a blocking missing "secret" there.
 */
import type { WranglerVariableIR } from "@lunora/codegen";
import { redact, secretKindOf } from "@lunora/codegen";
import { parseTree } from "jsonc-parser";

import { isPublicKeyName, isSecretKeyName } from "../../../../shared/secret-key";
import { isPlaceholderValue } from "../scaffold-dev-variables";

/**
 * A secret value shorter than this is almost always benign config (a version tag,
 * a small number-as-string, `"true"`), so the key-name-only heuristic ignores it —
 * the shape heuristic ({@link secretKindOf}) already has its own length floors and
 * is not gated by this.
 */
const MIN_SECRET_NAMED_VALUE_LENGTH = 8;

/**
 * Pure scan of a `vars` map for plaintext secrets — the FS-free core, exported for
 * unit tests. A variable is flagged when, for a **string** value that is neither a
 * placeholder nor a public/publishable key, EITHER the value matches a known
 * secret shape (`secretKindOf`) OR the key name strongly implies a secret and the
 * value is long enough to plausibly be one. `kind` is the matched shape, or
 * `secret_named_var` for the key-name path.
 */
const scanWranglerVariablesForSecrets = (
    variables: Record<string, unknown> | undefined,
    file: string,
    lineOf: (key: string) => number | undefined = () => undefined,
): WranglerVariableIR[] => {
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

        const line = lineOf(key);

        findings.push({ file, key, kind, preview: redact(rawValue), ...(line === undefined ? {} : { line }) });
    }

    return findings;
};

/**
 * The 1-based line of each top-level `vars` key in the `wrangler.jsonc` text, read from the JSONC tree so a comment or a
 * string that happens to contain a key cannot match. A repeated key (or a repeated `vars` object) maps to its last
 * occurrence, the one whose value the parser keeps and the scan judges.
 */
const variableKeyLines = (text: string): ReadonlyMap<string, number> => {
    const keyNodes = (parseTree(text, [], { allowTrailingComma: true })?.children ?? [])
        .filter((property) => property.children?.[0]?.value === "vars")
        .flatMap((property) => property.children?.[1]?.children ?? [])
        .flatMap((entry) => (typeof entry.children?.[0]?.value === "string" ? [entry.children[0]] : []));
    const lines = new Map<string, number>();
    let line = 1;
    let scanned = 0;

    for (const keyNode of keyNodes) {
        line += text.slice(scanned, keyNode.offset).split("\n").length - 1;
        scanned = keyNode.offset;
        lines.set(keyNode.value as string, line);
    }

    return lines;
};

export { scanWranglerVariablesForSecrets, variableKeyLines };
