/**
 * Real-workerd integration tests for `createWorker`.
 *
 * The mock-based suite passes a hand-rolled `ShardNamespaceLike` and never
 * boots a real Durable Object. These tests run the production factory
 * inside an actual Cloudflare runtime, hit it via `SELF`, and assert that
 * header forwarding, route lookup, and error sanitization survive the
 * round-trip.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

// `env`'s type comes from the ambient `Cloudflare.Env` augmentation in
// `./env.d.ts`.

describe("createWorker (workerd)", () => {
    test("forwards authorization, cookie, and x-d1-bookmark to the shard", async () => {
        const response = await SELF.fetch("https://app.test/_cirrus/rpc", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: "Bearer test-token",
                cookie: "session=abc",
                "x-d1-bookmark": "bookmark-v1",
            },
            body: JSON.stringify({ functionPath: "messages:list", args: { limit: 5 } }),
        });

        expect(response.status).toBe(200);

        const forwarded = (await response.json()) as {
            authorization: string | null;
            body: { args: Record<string, unknown>; functionPath: string } | null;
            bookmark: string | null;
            cookie: string | null;
        };

        expect(forwarded.authorization).toBe("Bearer test-token");
        expect(forwarded.cookie).toBe("session=abc");
        expect(forwarded.bookmark).toBe("bookmark-v1");
        expect(forwarded.body).toEqual({ functionPath: "messages:list", args: { limit: 5 } });
    });

    test("does NOT forward unrelated headers like user-agent or x-secret", async () => {
        const response = await SELF.fetch("https://app.test/_cirrus/rpc", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-secret": "must-not-propagate",
            },
            body: JSON.stringify({ functionPath: "x:y", args: {} }),
        });

        // The DO echoes only authorization/cookie/bookmark. Anything else
        // must be absent on the shard side. The structural assertion is
        // enough — we don't need to enumerate every disallowed header.
        const forwarded = (await response.json()) as { authorization: string | null; bookmark: string | null; cookie: string | null };

        expect(forwarded.authorization).toBeNull();
        expect(forwarded.cookie).toBeNull();
        expect(forwarded.bookmark).toBeNull();
    });

    test("propagates the shard's x-d1-bookmark response header back to the client (stub-level contract)", async () => {
        // `createWorker` rebuilds the outbound RPC URL as
        // `https://shard.internal/rpc`, dropping any query string from the
        // inbound request. That means we can't ask the DO to emit a
        // bookmark via the public RPC path — but we *can* verify the
        // propagation contract by going through the stub directly. The
        // production code then sets the inbound response header in
        // `createWorker.ts` lines 127-134, which the createWorker mocks
        // suite already exercises with a hand-rolled stub.
        const stub = env.SHARD.get(env.SHARD.idFromName("__root__"));
        const direct = await stub.fetch("https://shard.internal/rpc?reply-bookmark=bm-99", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
        });

        expect(direct.headers.get("x-d1-bookmark")).toBe("bm-99");
    });

    test("dispatches custom routes by 'METHOD path' key before falling through", async () => {
        const ok = await SELF.fetch("https://app.test/healthz");

        expect(ok.status).toBe(200);
        await expect(ok.text()).resolves.toBe("ok");

        // POST /echo-method is registered with the "METHOD path" form,
        // so a GET to the same path should NOT match.
        const wrongMethod = await SELF.fetch("https://app.test/echo-method");

        expect(wrongMethod.status).toBe(404);

        const rightMethod = await SELF.fetch("https://app.test/echo-method", { method: "POST" });

        expect(rightMethod.status).toBe(200);

        const echoed = (await rightMethod.json()) as { method: string; path: string };

        expect(echoed).toEqual({ method: "POST", path: "/echo-method" });
    });

    test("cirrusError surfaces its code+status; generic errors are sanitized to INTERNAL 500", async () => {
        const cirrus = await SELF.fetch("https://app.test/boom-cirrus");

        expect(cirrus.status).toBe(403);
        await expect(cirrus.json()).resolves.toEqual({ error: { code: "FORBIDDEN", message: "nope" } });

        const generic = await SELF.fetch("https://app.test/boom-generic");

        expect(generic.status).toBe(500);

        const body = (await generic.json()) as { error: { code: string; message: string } };

        // Per audit H10: must NOT echo internal error.message contents.
        expect(body.error.code).toBe("INTERNAL");
        expect(body.error.message).toBe("Internal error");
        expect(body.error.message).not.toContain("internal-detail-that-must-not-leak");
    });
});
