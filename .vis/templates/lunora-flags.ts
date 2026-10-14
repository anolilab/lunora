/**
 * `vis generate lunora-flags` — scaffold the feature-flags singleton in
 * lunora/flags.ts.
 *
 * Unlike queues or crons (which collect many declarations in one file), flags is
 * a singleton: a single `export default defineFlags({...})` that configures the
 * OpenFeature provider once for the whole app. Codegen discovers that default
 * export and wires `ctx.flags` onto every query/mutation/action context (plus the
 * `useFlag` / `useFlags` client hooks). So this template writes the file once and
 * REFUSES if it already exists — re-running would clobber your provider config.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { createTemplate } from "@visulima/vis/generate";

const freshFlags = (): string => `import { defineFlags } from "@lunora/flags";
import { flagshipProvider } from "@lunora/flags/providers/flagship";

export default defineFlags({
    // Cloudflare Flagship in Workers binding mode (no auth token needed).
    // Switch to flagshipProvider({ appId, accountId, authToken }) for HTTP mode,
    // or supply any OpenFeature provider factory: (env) => new SomeProvider(...).
    provider: flagshipProvider({ binding: "FLAGS" }),
    // Optional: default targetingKey for every evaluation (usually the user id).
    identify: (ctx) => ctx.auth?.userId,
});
`;

export default createTemplate({
    about: {
        description: "Scaffold the feature-flags singleton in lunora/flags.ts (refuses if it already exists)",
        name: "lunora-flags",
    },
    options: {
        name: {
            prompt: "Optional label for the flags config (unused — flags.ts is a singleton)",
            required: false,
            type: "string",
        },
    },
    produce: ({ builtins }) => {
        const flagsPath = join(builtins.dest_dir, "lunora", "flags.ts");

        if (existsSync(flagsPath)) {
            throw new Error(
                `lunora/flags.ts already exists at ${flagsPath} — flags is a singleton. Edit it directly to change the provider, or delete it first to re-scaffold.`,
            );
        }

        return {
            files: { lunora: { "flags.ts": freshFlags() } },
            suggestions: [
                "Created lunora/flags.ts with the Cloudflare Flagship provider (binding mode).",
                'Add the Flagship binding to wrangler.jsonc: { "flagship": [{ "binding": "FLAGS", "app_id": "<your-app-id>" }] }.',
                "Run `lunora codegen` (or just `lunora dev`) to wire `ctx.flags` and the `useFlag` client hooks.",
            ],
        };
    },
});
