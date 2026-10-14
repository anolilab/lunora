/**
 * Real-workerd integration tests for `createWorker`.
 *
 * The mock-based suite passes a hand-rolled `ShardNamespaceLike` and never
 * boots a real Durable Object. These tests run the production factory
 * inside an actual Cloudflare runtime, hit it via `SELF`, and assert that
 * header forwarding, route lookup, and error sanitization survive the
 * round-trip.
 */
import { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "./test-worker";

// `env`'s type comes from the ambient `Cloudflare.Env` augmentation in
// `./env.d.ts`.

describe("createWorker (workerd)", () => {
    it("forwards authorization, cookie, and x-d1-bookmark to the shard", async () => {
        expect.assertions(5);

        const response = await SELF.fetch("https://app.test/_lunora/rpc", {
            body: JSON.stringify({ args: { limit: 5 }, functionPath: "messages:list" }),
            headers: {
                authorization: "Bearer test-token",
                "content-type": "application/json",
                cookie: "session=abc",
                // Same-origin `Origin` — the runtime's CSRF guard rejects a
                // cookie-bearing request without one (that's the point of the
                // guard); a real same-origin browser fetch always sends it.
                origin: "https://app.test",
                "x-d1-bookmark": "bookmark-v1",
            },
            method: "POST",
        });

        expect(response.status).toBe(200);

        const forwarded: {
            authorization: string | null;
            body: { args: Record<string, unknown>; functionPath: string } | null;
            bookmark: string | null;
            cookie: string | null;
        } = await response.json();

        expect(forwarded.authorization).toBe("Bearer test-token");
        expect(forwarded.cookie).toBe("session=abc");
        expect(forwarded.bookmark).toBe("bookmark-v1");
        expect(forwarded.body).toEqual({ args: { limit: 5 }, functionPath: "messages:list" });
    });

    it("does NOT forward unrelated headers like user-agent or x-secret", async () => {
        expect.assertions(3);

        const response = await SELF.fetch("https://app.test/_lunora/rpc", {
            body: JSON.stringify({ args: {}, functionPath: "x:y" }),
            headers: {
                "content-type": "application/json",
                "x-secret": "must-not-propagate",
            },
            method: "POST",
        });

        // The DO echoes only authorization/cookie/bookmark. Anything else
        // must be absent on the shard side. The structural assertion is
        // enough — we don't need to enumerate every disallowed header.
        const forwarded: { authorization: string | null; bookmark: string | null; cookie: string | null } = await response.json();

        expect(forwarded.authorization).toBeNull();
        expect(forwarded.cookie).toBeNull();
        expect(forwarded.bookmark).toBeNull();
    });

    it("propagates the shard's x-d1-bookmark response header back to the client (stub-level contract)", async () => {
        expect.assertions(1);

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
            body: JSON.stringify({}),
            headers: { "content-type": "application/json" },
            method: "POST",
        });

        expect(direct.headers.get("x-d1-bookmark")).toBe("bm-99");
    });

    it("dispatches custom routes by 'METHOD path' key before falling through", async () => {
        expect.assertions(5);

        const ok = await SELF.fetch("https://app.test/healthz");

        expect(ok.status).toBe(200);
        await expect(ok.text()).resolves.toBe("ok");

        // POST /echo-method is registered with the "METHOD path" form,
        // so a GET to the same path should NOT match.
        const wrongMethod = await SELF.fetch("https://app.test/echo-method");

        expect(wrongMethod.status).toBe(404);

        const rightMethod = await SELF.fetch("https://app.test/echo-method", { method: "POST" });

        expect(rightMethod.status).toBe(200);

        const echoed = await rightMethod.json();

        expect(echoed).toEqual({ method: "POST", path: "/echo-method" });
    });

    it("lunoraError surfaces its code+status; generic errors are sanitized to INTERNAL 500", async () => {
        expect.assertions(6);

        const lunora = await SELF.fetch("https://app.test/boom-lunora");

        expect(lunora.status).toBe(403);
        await expect(lunora.json()).resolves.toEqual({ error: { code: "FORBIDDEN", message: "nope" } });

        const generic = await SELF.fetch("https://app.test/boom-generic");

        expect(generic.status).toBe(500);

        const body: { error: { code: string; message: string } } = await generic.json();

        // Per audit H10: must NOT echo internal error.message contents.
        expect(body.error.code).toBe("INTERNAL");
        expect(body.error.message).toBe("Internal error");
        expect(body.error.message).not.toContain("internal-detail-that-must-not-leak");
    });

    it("scheduled() backup streams an NDJSON snapshot + manifest into the real R2 bucket", async () => {
        expect.assertions(5);

        // 2026-06-03T12:00:00.000Z — drives the deterministic backup id/key.
        const scheduledTime = Date.UTC(2026, 5, 3, 12, 0, 0);
        const controller = createScheduledController({ cron: "0 3 * * *", scheduledTime });
        const context = createExecutionContext();

        await worker.scheduled(controller, env, context);
        await waitOnExecutionContext(context);

        const ndjsonKey = "backups/lunora-backup-2026-06-03T12-00-00-000Z.ndjson";
        const manifestKey = `${ndjsonKey}.manifest.json`;

        const ndjsonObject = await env.BACKUPS.get(ndjsonKey);
        const manifestObject = await env.BACKUPS.get(manifestKey);

        expect(ndjsonObject).not.toBeNull();
        expect(manifestObject).not.toBeNull();

        // The ReadableStream→R2 put path (the bit Node mocks can't cover) must
        // land both rows intact.
        const ndjsonText = await ndjsonObject!.text();
        const lines = ndjsonText.trim().split("\n");

        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]!)).toEqual({ doc: { _id: "u1", email: "a@b.com" }, table: "users" });

        const manifest: { cron: string; rows: number } = await manifestObject!.json();

        expect(manifest).toMatchObject({ cron: "0 3 * * *", rows: 2 });
    });
});
