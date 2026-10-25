/**
 * The signed frame for one `ShardRegistryDO` request: the method, the path and
 * query, then the body. The signature covers the frame rather than the body
 * alone, so a GET (whose body is empty) is authenticated too, and a captured
 * signature cannot be replayed against another route.
 *
 * The body is last because it may contain newlines; the three fields before it
 * never do. Zero-dependency: bundler-inlined into `@lunora/do` and `@lunora/runtime`.
 */
export const shardRegistryFrame = (method: string, url: URL, body: string): string =>
    ["lunora.shard-registry.v1", method, `${url.pathname}${url.search}`, body].join("\n");
