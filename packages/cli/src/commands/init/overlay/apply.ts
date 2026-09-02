/**
 * The create-vite overlay engine.
 *
 * Given a directory that already holds a stock `create-vite` base (fetched by
 * the caller), {@link applyLunoraOverlay} writes the small Lunora layer on top:
 * the `lunora/` backend, the Worker entry, `wrangler.jsonc`, the framework's
 * Lunora-wired entry file(s), and the dependency/`vite.config` patches. It does
 * NOT touch the framework's `App`, styles, or config beyond adding `lunora()` —
 * those come from create-vite untouched.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { dirname, join } from "@visulima/path";

import type { Logger } from "../../../util/logger";
import { patchViteConfig } from "../../../util/patch-vite-config";
import { resolveTagVersions } from "../../../util/source-ref";
import type { FrameworkAdapter } from "./adapters";

/** Ratelimit schema extension — defines the `ratelimit_buckets` table for durable rate limiting. */
const RATELIMIT_SCHEMA = `import type { Middleware } from "lunorash/server";
import { defineSchemaExtension, defineTable, definePlugin, v } from "lunorash/server";
import { createDbStore, RateLimiter } from "lunorash/ratelimit";
import type { RateLimitConfigMap } from "lunorash/ratelimit";

export const limits = {
    send: { kind: "token bucket", period: 60_000, rate: 30 },
} as const satisfies RateLimitConfigMap;

export type LimitName = keyof typeof limits;

export const makeRateLimiter = (ctx: { db: unknown }): RateLimiter<LimitName> =>
    new RateLimiter<LimitName>({
        config: limits,
        store: createDbStore({ db: ctx.db as never, table: "ratelimit_buckets" }),
    });

const middleware: Middleware<{ api?: Record<string, unknown>; db: unknown }, { api: Record<string, unknown>; db: unknown }> = ({ ctx, next }) =>
    next({
        ctx: {
            ...ctx,
            api: { ...ctx.api, ratelimit: makeRateLimiter(ctx) },
        },
    });

export const ratelimit = definePlugin("ratelimit", {
    extension: defineSchemaExtension("ratelimit", {
        tables: {
            buckets: defineTable({
                key: v.string(),
                value: v.number(),
                ts: v.number(),
                prev: v.optional(v.number()),
            })
                .index("by_key", ["key"])
                .externallyManaged(),
        },
    }),
    middleware,
});
`;

/** Canonical `lunora/schema.ts` — byte-identical to the bespoke templates' scaffold. */
const LUNORA_SCHEMA = `import { ratelimit } from "./ratelimit/schema.js";
import { defineSchema, defineTable, v } from "lunorash/server";

export default defineSchema({
    messages: defineTable({
        channelId: v.string(),
        text: v.string(),
    })
        .shardBy("channelId")
        .index("by_channel", ["channelId"]),
}).extend(ratelimit.extension);
`;

/**
 * Canonical `lunora/messages.ts` — byte-identical to the bespoke templates'
 * scaffold: one live `list` query + a rate-limited `send` mutation that inserts.
 * Written to pass the advisor cleanly out of the box (bounded string args, a
 * real `ctx.db.insert`, and a rate limit on the public mutation).
 */
const LUNORA_MESSAGES = `import { RateLimiter, rateLimit, createDbStore } from "lunorash/ratelimit";

import { mutation, query, v } from "#lunora/_generated/server.js";

const limiter = (ctx: { db: unknown }) => new RateLimiter({
    config: {
        send: { kind: "token bucket", period: 60_000, rate: 30 },
    },
    store: createDbStore({ db: ctx.db as never, table: "ratelimit_buckets" }),
});

export const list = query.input({ channelId: v.string().max(256), limit: v.optional(v.number()) }).query(async ({ args, ctx }) => {
    const messages = await ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
        .take(args.limit ?? 50);

    return { channelId: args.channelId, messages };
});

export const send = mutation
    .input({ channelId: v.string().max(256), text: v.string().max(4096) })
    .use(rateLimit(limiter, "send", { key: (ctx) => ctx.auth.userId ?? "anon" }))
    .mutation(async ({ args, ctx }) => {
        const id = await ctx.db.insert("messages", { channelId: args.channelId, text: args.text });

        return { channelId: args.channelId, id, text: args.text };
    });
`;

/** The Worker entry — composed via the generated `defineApp` builder. */
const SERVER_ENTRY = `import type { ShardNamespaceLike } from "lunorash/runtime";

import { defineApp } from "../lunora/_generated/app.js";

interface Env extends Record<string, unknown> {
    SHARD: ShardNamespaceLike;
}

const app = defineApp<Env>()
    .shard((env) => env.SHARD)
    .build();

export const ShardDO = app.ShardDO;
export default app;
`;

/** `wrangler.jsonc` — the SHARD Durable Object binding + migration. `__NAME__` is substituted. */
const WRANGLER = `{
    "$schema": "node_modules/wrangler/config-schema.json",
    "name": "__NAME__",
    "main": "src/server.ts",
    "compatibility_date": "2026-06-10",
    "compatibility_flags": ["nodejs_compat"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }],
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "observability": { "enabled": true, "head_sampling_rate": 1 },
}
`;

/** Lines the overlay ensures are present in `.gitignore` (keeps `.env.example` tracked). */
const GITIGNORE_ADDITIONS = [
    ".wrangler",
    ".env",
    ".env.*",
    "!.env.example",
    ".dev.vars",
    ".dev.vars.*",
    "!.dev.vars.example",
    ".lunora/",
    ".lunora-cache",
    "lunora/_generated",
];

/**
 * `.env.example` — documents the one client knob. The entry files read the Vite
 * env var, which Vite statically replaces at `vite dev` / build; unset it falls
 * back to the page origin.
 */
/* eslint-disable no-secrets/no-secrets -- env-var docs read as high-entropy strings */
const ENV_EXAMPLE = `# Lunora endpoint for the browser client.
# Vite statically replaces \`import.meta.env.VITE_LUNORA_URL\` at \`vite dev\` / build.
# Leave it unset to use the page origin; set it to point at a deployed Worker:
#
# VITE_LUNORA_URL=https://my-app.example.workers.dev
`;
/* eslint-enable no-secrets/no-secrets */

/** The dev-time deps every overlaid project needs on top of the framework adapter. */
const COMMON_DEV_DEPENDENCIES: Record<string, string> = {
    "@cloudflare/workers-types": "^4.20260611.1",
    wrangler: "^4.100.0",
};

const writeFile = (target: string, relativePath: string, contents: string, written: string[]): void => {
    const destination = join(target, relativePath);

    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents, "utf8");
    written.push(destination);
};

/** Matches a line break (CR/CRLF/LF) — hoisted so it isn't recompiled per call. */
const NEWLINE = /\r?\n/;

/** Append any missing {@link GITIGNORE_ADDITIONS} to the base's `.gitignore` (create-vite always ships one). */
const ensureGitignore = (target: string): void => {
    const path = join(target, ".gitignore");
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    const existingLines = new Set(existing.split(NEWLINE));
    const missing = GITIGNORE_ADDITIONS.filter((entry) => !existingLines.has(entry));

    if (missing.length === 0) {
        return;
    }

    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";

    writeFileSync(path, `${existing}${prefix}\n# Lunora\n${missing.join("\n")}\n`, "utf8");
};

/** True for the unscoped umbrella or any `@lunora/*` package. */
const isLunoraDep = (name: string): boolean => name === "lunorash" || name.startsWith("@lunora/");

/**
 * Pin a Lunora-scoped dependency to its concrete version (from `versions`),
 * falling back to the channel dist-tag when unresolved; non-Lunora deps keep
 * their range. Pinning the exact version stops a stale lockfile/metadata cache
 * silently installing an older release than the channel currently points at.
 */
const stampRange = (name: string, range: string, distTag: string, versions: ReadonlyMap<string, string>): string =>
    isLunoraDep(name) ? (versions.get(name) ?? distTag) : range;

/** A pure "add this dep" — returns a new map, never mutating the input. Lunora ranges are pinned later by {@link restampLunora}. */
const withDependency = (map: Record<string, string>, name: string, range: string): Record<string, string> => {
    return { ...map, [name]: range };
};

/** Stamp every Lunora-scoped range in a dep map to its concrete version (or the tag fallback). */
const restampLunora = (map: Record<string, string>, distTag: string, versions: ReadonlyMap<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(map).map(([name, range]) => [name, stampRange(name, range, distTag, versions)]));

/**
 * Merge the Lunora deps + name + scripts into the base's `package.json`. The
 * framework deps create-vite declared are kept verbatim; Lunora ranges are
 * pinned to the concrete published version of the channel (tag fallback offline).
 */
const patchPackageJson = async (target: string, name: string, adapter: FrameworkAdapter, distTag: string): Promise<void> => {
    const path = join(target, "package.json");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> & {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        imports?: Record<string, string>;
        scripts?: Record<string, string>;
    };

    let dependencies = withDependency(parsed.dependencies ?? {}, "lunorash", distTag);

    // The scaffolded `lunora/messages.ts` rate-limits its public `send` mutation
    // (so the starter passes the advisor clean), which imports `@lunora/ratelimit`.
    dependencies = withDependency(dependencies, "@lunora/ratelimit", distTag);

    // Vanilla talks to Lunora through `lunorash/client` (a subpath of the
    // umbrella) — no separate adapter package to install.
    if (adapter.adapter.startsWith("@lunora/")) {
        dependencies = withDependency(dependencies, adapter.adapter, distTag);
    }

    for (const [depName, range] of Object.entries(adapter.extraDependencies ?? {})) {
        dependencies = withDependency(dependencies, depName, range);
    }

    let devDependencies = withDependency(parsed.devDependencies ?? {}, "@lunora/vite", distTag);

    // The local Studio (served at `/__lunora` in dev) is an OPTIONAL peer of
    // `@lunora/vite`, so pnpm won't install it transitively — list it as a
    // dev dependency so the studio works out of the box.
    devDependencies = withDependency(devDependencies, "@lunora/studio", distTag);

    for (const [depName, range] of Object.entries(COMMON_DEV_DEPENDENCIES)) {
        devDependencies = withDependency(devDependencies, depName, range);
    }

    // Resolve every Lunora-scoped dep's tag → concrete version once, then pin.
    const lunoraNames = [...Object.keys(dependencies), ...Object.keys(devDependencies)].filter((depName) => isLunoraDep(depName));
    const versions = await resolveTagVersions(lunoraNames, distTag);

    parsed.name = name;
    // The generated `lunora/_generated/*` and the registry files (`lunora/<feature>/…`)
    // import via the `#lunora/*` subpath; the create-vite base has no such mapping,
    // so add it (the bespoke templates ship it) — without it the worker entry fails
    // with "Cannot find module '#lunora/_generated/server.js'".
    parsed.imports = { ...parsed.imports, "#lunora/*": "./lunora/*" };
    parsed.dependencies = restampLunora(dependencies, distTag, versions);
    parsed.devDependencies = restampLunora(devDependencies, distTag, versions);
    parsed.scripts = { ...parsed.scripts, codegen: "lunora codegen", deploy: "vite build && lunora deploy" };

    writeFileSync(path, `${JSON.stringify(parsed, undefined, 4)}\n`, "utf8");
};

/** Ordered list of vite config filenames to probe. */
const VITE_CONFIG_CANDIDATES = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"] as const;

/** The first existing `vite.config.*` in `cwd`, or `undefined` when none exists. */
const findExistingViteConfig = (cwd: string): string | undefined => VITE_CONFIG_CANDIDATES.map((file) => join(cwd, file)).find((path) => existsSync(path));

/** Add `lunora()` to whichever `vite.config.*` create-vite shipped (keeps the framework plugin). */
const patchBaseViteConfig = (target: string, logger: Logger): void => {
    const candidate = findExistingViteConfig(target);

    if (candidate === undefined) {
        logger.warn("overlay: no vite.config found in the create-vite base — add `lunora()` to your Vite plugins manually.");

        return;
    }

    const result = patchViteConfig(readFileSync(candidate, "utf8"));

    if (result.changed) {
        writeFileSync(candidate, result.code, "utf8");
    }
};

interface ApplyOverlayOptions {
    /** The framework adapter (entry files + adapter package). */
    adapter: FrameworkAdapter;
    /** The CLI release channel to pin Lunora deps to. */
    distTag: string;
    logger: Logger;
    /** The project name (becomes `package.json`/`wrangler.jsonc` `name`). */
    name: string;
    /** Directory holding the create-vite base; the overlay is written in place. */
    target: string;
}

/**
 * Apply the Lunora overlay onto a create-vite base already present at
 * `options.target`. Returns the project-relative paths the overlay wrote.
 */
const applyLunoraOverlay = async (options: ApplyOverlayOptions): Promise<ReadonlyArray<string>> => {
    const { adapter, distTag, logger, name, target } = options;
    const written: string[] = [];

    writeFile(target, join("lunora", "ratelimit", "schema.ts"), RATELIMIT_SCHEMA, written);
    writeFile(target, join("lunora", "schema.ts"), LUNORA_SCHEMA, written);
    writeFile(target, join("lunora", "messages.ts"), LUNORA_MESSAGES, written);
    writeFile(target, join("src", "server.ts"), SERVER_ENTRY, written);
    writeFile(target, "wrangler.jsonc", WRANGLER.replaceAll("__NAME__", name), written);
    writeFile(target, ".env.example", ENV_EXAMPLE, written);
    // (pnpm-workspace.yaml — the build-script allowlist — is written by the init
    // install step only when pnpm is the chosen package manager.)

    for (const file of adapter.files) {
        writeFile(target, file.path, file.contents, written);
    }

    patchBaseViteConfig(target, logger);
    await patchPackageJson(target, name, adapter, distTag);
    ensureGitignore(target);

    return written;
};

export { applyLunoraOverlay, findExistingViteConfig, isLunoraDep };
export type { ApplyOverlayOptions };
