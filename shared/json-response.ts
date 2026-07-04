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
 * `bookmark`, when given, rides as the `x-d1-bookmark` response header — the
 * read-your-writes cursor `ShardDO` propagates back to callers pinning reads
 * after a write. Consumers with no bookmark concept simply omit the argument.
 */
export const jsonResponse = (body: unknown, status = 200, bookmark?: string): Response => {
    const headers: Record<string, string> = { "content-type": "application/json" };

    if (bookmark) {
        headers["x-d1-bookmark"] = bookmark;
    }

    return Response.json(body, { headers, status });
};
