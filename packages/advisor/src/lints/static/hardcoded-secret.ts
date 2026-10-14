import { dedupeCacheKeys } from "../../dedupe-cache-keys";
import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a secret-shaped string literal checked into the lunora source.
 *
 * A live API key, access key, private key, or high-entropy token committed to the
 * codebase leaks the moment the repo is cloned, forked, or its history is read —
 * and rotating it means a redeploy. Secrets belong in `.dev.vars` locally and
 * `wrangler secret put` in production, read at runtime via `env`. This lint
 * surfaces the same class of finding the pre-commit `vis secrets` gate catches,
 * inside the studio Advisors table.
 *
 * Runs only when the codegen feeder supplies secret evidence
 * (`context.secretLiterals`); a runtime caller flags nothing. One finding per
 * literal.
 */
const hardcodedSecret: Lint = {
    categories: ["SECURITY"],
    description:
        "A secret-shaped string literal (live API key, access key, private key, or high-entropy token) is hard-coded in the source. Committed secrets leak via clone/fork/history and force a redeploy to rotate.",
    facing: "INTERNAL",
    level: "ERROR",
    name: "hardcoded_secret",
    remediation:
        'Move the secret out of source: set it locally in `.dev.vars` (`lunora env set <NAME> "<value>"`) and in production with `wrangler secret put <NAME>`, then read it at runtime from `env.<NAME>`. Rotate the exposed value — assume it is already compromised.',
    run: (context) => {
        if (context.secretLiterals === undefined) {
            return [];
        }

        // Two secrets of the same kind on one physical source line (e.g.
        // `[STRIPE_LIVE_A, STRIPE_LIVE_B]`) would otherwise share a cacheKey and
        // collapse to one dismissible finding, hiding the second. The shared
        // `dedupeCacheKeys` pass suffixes the repeat so both survive.
        return dedupeCacheKeys(
            context.secretLiterals.map((secret) =>
                emit(hardcodedSecret, {
                    cacheKey: `hardcoded_secret:${secret.file}:${secret.line.toString()}:${secret.kind}`,
                    detail: `A ${secret.kind.replaceAll("_", " ")} (${secret.preview}) is hard-coded at ${secret.file}:${secret.line.toString()}. Move it to \`.dev.vars\` / \`wrangler secret put\` and read it from \`env\`. Rotate the exposed value.`,
                    metadata: { file: secret.file, kind: secret.kind, line: secret.line, preview: secret.preview },
                }),
            ),
        );
    },
    source: "static",
    title: "Hard-coded secret in source",
};

export default hardcodedSecret;
