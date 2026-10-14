import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `new RateLimiter({...})` constructed without an explicit `store`.
 *
 * The default store is per-instance in-memory. On Cloudflare Workers each request
 * can land on a different isolate, so an in-memory counter never sums across
 * them: the limiter silently under-counts and, under real traffic, is close to a
 * no-op. A rate limit that doesn't actually limit gives a false sense of
 * protection against brute-force, enumeration, and cost-abuse — exactly the
 * attacks it was added to stop. The fix is a shared, durable store (a Durable
 * Object or KV-backed one) so every isolate reads and writes the same bucket.
 *
 * Runs only when the codegen feeder supplies config-call evidence
 * (`context.configCalls`); a runtime caller flags nothing. Skips calls whose
 * config wasn't a static object literal. One finding per limiter.
 */
const ratelimitDefaultMemoryStore: Lint = {
    categories: ["SECURITY"],
    description:
        "`new RateLimiter({...})` has no `store`, so it falls back to a per-instance in-memory store. On Workers each request may hit a different isolate, so the counter never sums across them — the limit silently under-counts and is effectively a no-op under load, giving false protection against brute-force and cost abuse.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "ratelimit_default_memory_store",
    remediation:
        "Pass a shared, durable `store` to `new RateLimiter({...})` (a Durable-Object- or KV-backed store) so every Worker isolate reads and writes the same bucket. The default in-memory store is per-isolate and does not enforce a global limit.",
    run: (context) => {
        if (context.configCalls === undefined) {
            return [];
        }

        return context.configCalls
            .filter((call) => call.callee === "RateLimiter" && call.analyzable && !call.presentKeys.includes("store"))
            .map((call) =>
                emit(ratelimitDefaultMemoryStore, {
                    cacheKey: `ratelimit_default_memory_store:${call.file}:${call.line.toString()}`,
                    detail: `\`new RateLimiter({...})\` in ${call.file}:${call.line.toString()} has no \`store\` — it uses the per-instance in-memory store, which never sums across Worker isolates, so the limit silently under-counts under load. Pass a Durable-Object- or KV-backed \`store\` so the limit is enforced globally.`,
                    metadata: { callee: call.callee, file: call.file, line: call.line },
                }),
            );
    },
    source: "static",
    title: "RateLimiter using the default in-memory store",
};

export default ratelimitDefaultMemoryStore;
