/**
 * Tests for the typed server-side shard client.
 *
 * These pin the exact wire contract a plain Worker would otherwise hand-roll — the
 * URL, the body shape, and the identity/system headers — because the whole point of
 * the abstraction is that an adopter never has to reproduce it (and cannot get the
 * trust-boundary header subtly wrong).
 */
import { describe, expect, it } from "vitest";

import { encodeIdentityHeader } from "../../../shared/identity-header";
import type { ShardNamespaceLike } from "../src/resolve-shard";
import type { ShardFunctionReference } from "../src/shard-client";
import { createShardClient } from "../src/shard-client";

interface CapturedCall {
    body: unknown;
    headers: Record<string, string>;
    shardKey: string;
    url: string;
}

/** A namespace double that records each call and replies with a canned envelope. */
const createNamespace = (respond: (call: CapturedCall) => Response): { calls: CapturedCall[]; namespace: ShardNamespaceLike } => {
    const calls: CapturedCall[] = [];

    const namespace: ShardNamespaceLike = {
        get: () => {
            throw new Error("unused: getByName is preferred");
        },
        getByName: (shardKey: string) => {
            return {
                fetch: async (request: Request) => {
                    const captured: CapturedCall = {
                        body: JSON.parse(await request.text()),
                        headers: Object.fromEntries(request.headers),
                        shardKey,
                        url: request.url,
                    };

                    calls.push(captured);

                    return respond(captured);
                },
            };
        },
        idFromName: (name: string) => name,
    };

    return { calls, namespace };
};

const ok = (result: unknown): Response => Response.json({ result });

describe("createShardClient", () => {
    it("posts the shard RPC envelope an app would otherwise hand-roll", async () => {
        expect.assertions(4);

        const { calls, namespace } = createNamespace(() => ok(["a", "b"]));

        const client = createShardClient(namespace).forShard("user-1");
        const result = await client.call("mcp:listNodes", { userId: "user-1" });

        expect(result).toStrictEqual(["a", "b"]);
        expect(calls[0]?.url).toBe("https://shard.internal/rpc");
        expect(calls[0]?.body).toStrictEqual({ args: { userId: "user-1" }, functionPath: "mcp:listNodes" });
        expect(calls[0]?.shardKey).toBe("user-1");
    });

    it("resolves a generated function reference to its path", async () => {
        expect.assertions(1);

        const { calls, namespace } = createNamespace(() => ok(null));
        // Shape of a codegen `internal.*` entry: the phantom marker is type-only, so
        // at runtime only `__lunoraRef` exists.
        const reference = { __lunoraRef: "mcp:listNodes" } as const;

        await createShardClient(namespace).forShard("u1").call(reference, {});

        expect((calls[0]?.body as { functionPath: string }).functionPath).toBe("mcp:listNodes");
    });

    it("is a system caller by default, so it may reach internal functions", async () => {
        expect.assertions(2);

        const { calls, namespace } = createNamespace(() => ok(null));

        await createShardClient(namespace, { shardKey: "u1" }).call("mcp:listNodes", {});

        expect(calls[0]?.headers["x-lunora-system"]).toBe("1");
        expect(calls[0]?.headers["x-lunora-userid"]).toBeUndefined();
    });

    it("carries system privilege AND the end-user identity together", async () => {
        expect.assertions(3);

        const { calls, namespace } = createNamespace(() => ok(null));

        await createShardClient(namespace)
            .as({ claims: { email: "a@b.c" }, userId: "u1" })
            .forShard("u1")
            .call("mcp:listNodes", {});

        // A trusted server acting on behalf of a user needs both: the system flag to
        // reach `internal*`, the identity so RLS/ownership sees the real user.
        expect(calls[0]?.headers["x-lunora-system"]).toBe("1");
        expect(calls[0]?.headers["x-lunora-userid"]).toBe("u1");
        expect(calls[0]?.headers["x-lunora-identity"]).toBe(encodeIdentityHeader({ email: "a@b.c" }));
    });

    it("encodes non-Latin-1 `.as()` claims so the header value stays a valid ByteString", async () => {
        expect.assertions(2);

        const { calls, namespace } = createNamespace(() => ok(null));

        await createShardClient(namespace)
            .as({ claims: { name: "名前 🎌" }, userId: "u1" })
            .forShard("u1")
            .call("mcp:listNodes", {});

        const identityHeader = calls[0]?.headers["x-lunora-identity"] ?? "";
        let isByteStringSafe = identityHeader.length > 0;

        for (let index = 0; index < identityHeader.length; index += 1) {
            if ((identityHeader.codePointAt(index) ?? 0) > 255) {
                isByteStringSafe = false;
            }
        }

        // Every code unit must be <= 255 (WebIDL `ByteString`-safe) — this is the
        // literal property `new Request(...)` enforces at the real fetch call below;
        // a raw `JSON.stringify({ name: "名前 🎌" })` would violate it.
        expect(isByteStringSafe).toBe(true);
        expect(identityHeader).toBe(encodeIdentityHeader({ name: "名前 🎌" }));
    });

    it("drops the system flag when the caller opts out", async () => {
        expect.assertions(2);

        const { calls, namespace } = createNamespace(() => ok(null));

        await createShardClient(namespace, { shardKey: "u1", system: false }).as({ userId: "u1" }).call("mcp:listNodes", {});

        // Behaves exactly like an end-user RPC, so an accidental `internal.*` call is
        // rejected by the shard instead of quietly succeeding.
        expect(calls[0]?.headers["x-lunora-system"]).toBeUndefined();
        expect(calls[0]?.headers["x-lunora-userid"]).toBe("u1");
    });

    it("asSystem() sheds an inherited identity", async () => {
        expect.assertions(1);

        const { calls, namespace } = createNamespace(() => ok(null));

        await createShardClient(namespace, { as: { userId: "u1" }, shardKey: "u1" })
            .asSystem()
            .call("mcp:listNodes", {});

        expect(calls[0]?.headers["x-lunora-userid"]).toBeUndefined();
    });

    it("forwards a mutation id so an at-least-once retry applies once", async () => {
        expect.assertions(1);

        const { calls, namespace } = createNamespace(() => ok(null));

        await createShardClient(namespace, { shardKey: "u1" }).call("mcp:commit", {}, { mutationId: "webhook-evt-7" });

        expect(calls[0]?.headers["x-lunora-mutation-id"]).toBe("webhook-evt-7");
    });

    it("round-trips wire-codec values so a bigint survives the hop", async () => {
        expect.assertions(2);

        // The DO encodes its result with the same codec, so a plain `JSON.parse` on
        // either side would hand back the tagged wrapper instead of the value.
        const { calls, namespace } = createNamespace((call) => Response.json({ result: (call.body as { args: unknown }).args }));

        const result = await createShardClient(namespace, { shardKey: "u1" }).call("mcp:echo", { big: 9_007_199_254_740_993n });

        expect(result).toStrictEqual({ big: 9_007_199_254_740_993n });
        // The encoded form on the wire is NOT the raw bigint (JSON can't carry one).
        expect(JSON.stringify(calls[0]?.body)).toContain("9007199254740993");
    });

    it("rethrows the server's coded error so callers branch identically to the browser client", async () => {
        expect.assertions(2);

        const { namespace } = createNamespace(() => Response.json({ error: { code: "FORBIDDEN", message: "not your shard" } }, { status: 403 }));

        const call = createShardClient(namespace, { shardKey: "u1" }).call("mcp:listNodes", {});

        await expect(call).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(call).rejects.toThrow("not your shard");
    });

    it("surfaces a non-2xx with no error envelope instead of reading it as success", async () => {
        expect.assertions(1);

        const { namespace } = createNamespace(() => Response.json({ unexpected: true }, { status: 502 }));

        await expect(createShardClient(namespace, { shardKey: "u1" }).call("mcp:listNodes", {})).rejects.toThrow(/failed \(status 502/);
    });

    it("surfaces a non-JSON response", async () => {
        expect.assertions(1);

        const { namespace } = createNamespace(() => new Response("<html>gateway</html>", { status: 500 }));

        await expect(createShardClient(namespace, { shardKey: "u1" }).call("mcp:listNodes", {})).rejects.toThrow(/was not JSON \(status 500/);
    });

    it("fails with an actionable message when no shard key was supplied", async () => {
        expect.assertions(1);

        const { namespace } = createNamespace(() => ok(null));

        await expect(createShardClient(namespace).call("mcp:listNodes", {})).rejects.toThrow(/no shard key for "mcp:listNodes"/);
    });

    it("rejects something that is not a function reference", async () => {
        expect.assertions(1);

        const { namespace } = createNamespace(() => ok(null));

        await expect(createShardClient(namespace, { shardKey: "u1" }).call({} as unknown as string, {})).rejects.toThrow(
            /expected a generated function reference/,
        );
    });

    it("infers args and return from a generated reference", async () => {
        expect.assertions(2);

        const { namespace } = createNamespace(() => ok([{ _id: "n1", text: "hi" }]));

        // The shape codegen emits: a phantom marker carrying kind/args/return. This is
        // the assertion that the `call` signature actually threads it through, rather
        // than degrading everything to `unknown` (which the earlier `never` constraint
        // silently did for any real ref).
        const listNodes: ShardFunctionReference<{ userId: string }, { _id: string; text: string }[]> = { __lunoraRef: "mcp:listNodes" };

        const nodes = await createShardClient(namespace, { shardKey: "u1" }).call(listNodes, { userId: "u1" });

        // `nodes` is typed, not `unknown`: reading `.text` compiles.
        expect(nodes[0]?.text).toBe("hi");
        expect(nodes).toHaveLength(1);
    });

    it("routes through a jurisdiction-pinned namespace when one is configured", async () => {
        expect.assertions(2);

        const { calls, namespace } = createNamespace(() => ok(null));
        let pinned: string | undefined;

        const withJurisdiction: ShardNamespaceLike = {
            ...namespace,
            jurisdiction: (value) => {
                pinned = value;

                return namespace;
            },
        };

        await createShardClient(withJurisdiction, { jurisdiction: "eu", shardKey: "u1" }).call("mcp:listNodes", {});

        expect(pinned).toBe("eu");
        expect(calls).toHaveLength(1);
    });
});
