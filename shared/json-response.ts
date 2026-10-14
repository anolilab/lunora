/**
 * Shared `Response.json(...)` builder for Lunora's Durable Object HTTP
 * surfaces and the payment facade.
 *
 * Five call sites (`ShardDO`, `SessionDO`, `ShardRegistryDO`, `SchedulerDO`,
 * `createPayment`'s webhook handler) used to hand-roll their own
 * `jsonResponse`, drifting in both argument order (`(status, body)` vs
 * `(body, status)`) and header set. This is the one canonical builder;
 * consumers import it by relative path (see the `shared/` rules in
 * AGENTS.md — no runtime dependency edge, inlined per consumer's bundle).
 *
 * `headers`, when given, are merged over the `content-type` default —
 * consumer-specific response headers (e.g. `ShardDO`'s read-your-writes
 * `x-d1-bookmark` cursor) stay a consumer concern rather than a parameter of
 * the shared helper.
 *
 * Merged through `Headers`, whose `set` is case-INSENSITIVE, rather than by
 * object spread. HTTP header names are case-insensitive, so a spread keeps
 * `content-type` and a caller's `Content-Type` as two distinct keys and `Headers`
 * then COMBINES them — `application/json, application/problem+json` — instead of
 * letting the caller override. (`shared/otlp.ts` case-folds its own merge for
 * exactly this reason.)
 */
export const jsonResponse = (body: unknown, status = 200, headers?: Record<string, string>): Response => {
    const merged = new Headers({ "content-type": "application/json" });

    for (const [name, value] of Object.entries(headers ?? {})) {
        merged.set(name, value);
    }

    return Response.json(body, { headers: merged, status });
};
