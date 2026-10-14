import { dedupeCacheKeys } from "../../dedupe-cache-keys";
import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a plaintext secret committed to `wrangler.jsonc`'s `vars` block.
 *
 * `vars` are **plaintext environment variables**: Wrangler bakes them into the
 * deployed Worker's bundle in cleartext, and `wrangler.jsonc` is checked into
 * source control — so a real API key, access key, private key, or token placed
 * there leaks two ways at once (every reader of the repo and the deployed bundle)
 * and rotating it means editing tracked config plus a redeploy. Secrets belong in
 * a Secrets Store binding (`ctx.secrets.get(name)`) or `wrangler secret put`, never
 * `vars`. The evidence comes from `@lunora/config`, which reads `wrangler.jsonc`
 * and applies the same secret-shape heuristics as `hardcoded_secret`, plus a
 * secret-suggestive key-name rule (`*_KEY` / `*_SECRET` / `*_TOKEN` / `*_PASSWORD`
 * / `*_DSN`), while skipping placeholders and public/publishable keys.
 *
 * Runs only when the config feeder supplies wrangler-variable evidence
 * (`context.wranglerVariables`); a runtime caller flags nothing. One finding per var.
 */
const plaintextSecretInWranglerVariables: Lint = {
    categories: ["SECURITY"],
    description:
        "A plaintext secret is committed to `wrangler.jsonc`'s `vars` block. `vars` are cleartext — baked into the deployed Worker and checked into source control — so the secret leaks via the repo and the bundle, and rotating it needs a config edit plus a redeploy.",
    facing: "INTERNAL",
    level: "ERROR",
    name: "plaintext_secret_in_wrangler_vars",
    remediation:
        "Move the value out of `vars`: bind it through a Secrets Store (`ctx.secrets.get(<NAME>)`) or set it with `wrangler secret put <NAME>` and read it from `env.<NAME>`. Delete the `vars` entry and rotate the exposed value — assume it is already compromised. Public/publishable keys (name them `*_PUBLIC` / `*_PUBLISHABLE`) are exempt.",
    run: (context) => {
        if (context.wranglerVariables === undefined) {
            return [];
        }

        // A given key appears once per file, but guard against duplicate evidence
        // rows collapsing to one dismissible finding all the same: the shared
        // `dedupeCacheKeys` pass suffixes repeats of a (file, key) cacheKey.
        return dedupeCacheKeys(
            context.wranglerVariables.map((wranglerVariable) =>
                emit(plaintextSecretInWranglerVariables, {
                    cacheKey: `plaintext_secret_in_wrangler_vars:${wranglerVariable.file}:${wranglerVariable.key}`,
                    detail: `The \`vars\` entry \`${wranglerVariable.key}\` in ${wranglerVariable.file} holds a plaintext ${wranglerVariable.kind.replaceAll("_", " ")} (${wranglerVariable.preview}). \`vars\` ship in cleartext to the deployed Worker and are committed to source control — move it to a Secrets Store binding or \`wrangler secret put\` and rotate the exposed value.`,
                    metadata: { file: wranglerVariable.file, key: wranglerVariable.key, kind: wranglerVariable.kind, preview: wranglerVariable.preview },
                }),
            ),
        );
    },
    source: "static",
    title: "Plaintext secret in wrangler vars",
};

export default plaintextSecretInWranglerVariables;
