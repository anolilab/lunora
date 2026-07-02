import type { RateLimitConfigMap } from "@lunora/ratelimit";
import { dbRateLimit } from "@lunora/ratelimit";

import { action, query } from "./_generated/server.js";

// 10 seeds per minute per caller — plenty for a demo, and it models the
// public-write rate-limiting the schema advisor expects (see avatars.ts).
const limits = { seedKv: { kind: "token bucket", period: 60_000, rate: 10 } } satisfies RateLimitConfigMap;

/**
 * The demo entries {@link seedKv} writes — plain-text and JSON values, some with
 * metadata, some with a TTL — so the Studio's KV browser has a representative
 * mix to show (and the metadata/expiration a save must round-trip).
 */
const DEMO_ENTRIES: ReadonlyArray<{ key: string; options?: { expirationTtl?: number; metadata?: unknown }; value: string }> = [
    { key: "greeting", options: { metadata: { seededBy: "playground" } }, value: "hello from the lunora playground" },
    { key: "config:theme", value: JSON.stringify({ accent: "amethyst", mode: "dark" }) },
    { key: "counter:visits", value: "42" },
    { key: "session:demo", options: { expirationTtl: 3600, metadata: { userId: "u_demo" } }, value: "tok_abc123" },
    { key: "feature:beta", options: { metadata: { rolloutPct: 25 } }, value: "on" },
    { key: "cache:home", options: { expirationTtl: 300 }, value: JSON.stringify({ items: 3, ok: true }) },
];

/**
 * Seed a handful of Workers KV entries so the Studio's KV browser has something
 * to show. Reading `ctx.kv` here is what makes codegen wire the `env.KV` binding
 * onto the context AND the Studio's KV page + admin introspector — so this
 * function is both the demo data *and* the switch that lights up the KV tab.
 *
 * Run it once from the Studio's function runner (Functions → `seedKv` → Run),
 * then open the KV page under the Storage domain.
 */
export const seedKv = action
    .use(dbRateLimit(limits, "seedKv", { key: (ctx) => ctx.auth.userId ?? ctx.ip ?? "anonymous" }))
    .action(async ({ ctx }): Promise<{ seeded: number }> => {
        // `raw: true` writes the string verbatim (no JSON.stringify) so the browser
        // shows clean values instead of double-encoded ones. Written in parallel.
        await Promise.all(DEMO_ENTRIES.map((entry) => ctx.kv.put(entry.key, entry.value, { raw: true, ...entry.options })));

        return { seeded: DEMO_ENTRIES.length };
    });

/** List the current KV keys — the same data the Studio's KV browser shows, runnable from the function runner. */
export const listKv = query.query(async ({ ctx }): Promise<{ keys: string[] }> => {
    const result = await ctx.kv.list();

    return { keys: result.keys.map((entry) => entry.name) };
});
