/**
 * Node adapter: an in-process registry satisfying the provider-neutral
 * `@lunora/platform` `ShardDirectory` contract.
 *
 * Cloudflare's directory is backed by `DurableObjectNamespace` — placement is
 * the runtime's job, and `idFromName` derives a real, opaque, routable id. A
 * Node process has no such router: there is exactly one process, so "placement"
 * collapses to "look the name up in a `Map`". `idForName` returns the name
 * itself rather than a synthesized opaque id, because there is nothing to hide
 * behind the id — no cross-node routing, no jurisdiction, no sharding beyond
 * what the caller does themselves. Note the contract type still spells `id` as
 * `unknown`, so this is a legitimate (if degenerate) implementation choice, not
 * a violation.
 *
 * `jurisdiction` is deliberately **omitted**. A directory that returns itself
 * unchanged would silently ignore the requested restriction — indistinguishable
 * from having honored it as far as the type system is concerned, and a real
 * data-residency bug if anyone ever depended on it. The contract already
 * defines the correct behavior for a host that cannot restrict placement:
 * "callers must fail closed when a jurisdiction is requested but the method is
 * absent." Omitting it is what makes that fail-closed path real rather than a
 * theoretical clause nothing exercises — see the findings log.
 */

import type { DirectShardDirectory, ShardStub } from "@lunora/platform";

/**
 * Build an in-process shard directory. Every distinct name gets its own stub,
 * lazily created and cached, so `resolveShard(directory, name)` is idempotent
 * for the same name — the property the TCK's "resolves shard keys
 * deterministically" test checks.
 */
export const createNodeShardDirectory = (): DirectShardDirectory => {
    const stubs = new Map<string, ShardStub>();

    const stubFor = (name: string): ShardStub => {
        const existing = stubs.get(name);

        if (existing !== undefined) {
            return existing;
        }

        const stub: ShardStub = {
            // The reference host's stub echoes the shard id in the response body so
            // the TCK can assert two resolutions of the same key produced the same
            // body without reaching into host internals. This host does the same.
            // eslint-disable-next-line @typescript-eslint/require-await -- the contract's fetch is async so a real host can dispatch over the network; this host answers in-process
            fetch: async (_request) => new Response(name),
        };

        stubs.set(name, stub);

        return stub;
    };

    return {
        get: (id) => stubFor(String(id)),
        getByName: (name) => stubFor(name),
        idForName: (name) => name,
    };
};
