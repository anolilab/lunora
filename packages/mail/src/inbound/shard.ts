/**
 * Structural projections of the `SHARD` Durable Object namespace + one shard
 * stub, shared by the inbound dispatcher. Mirrors the shapes the outbound dev
 * capture sink uses (`packages/mail/src/from-env.ts`) so inbound dispatch routes
 * a parsed message into a Lunora function over the exact same admin-RPC-over-shard
 * path — without importing any Cloudflare types into `@lunora/mail`.
 */

/** Structural projection of one shard stub — only `fetch` returning something with `.json()`. */
interface ShardStubLike {
    fetch: (input: string, init?: { body?: string; headers?: Record<string, string>; method?: string }) => Promise<{ json: () => Promise<unknown> }>;
}

/** Structural projection of the `SHARD` Durable Object namespace. */
interface ShardNamespaceLike {
    get: (id: unknown) => ShardStubLike;
    idFromName: (name: string) => unknown;
}

export type { ShardNamespaceLike, ShardStubLike };
