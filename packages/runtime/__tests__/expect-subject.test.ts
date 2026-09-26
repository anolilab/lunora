import { describe, expect, it } from "vitest";

import { encodeExpectedSubjectHeader, EXPECT_SUBJECT_HEADER } from "../../../shared/identity-header";
import type { ExecutionContextLike, ResolvedIdentity } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

/**
 * A replayed offline write names the user it was queued by. The worker must
 * refuse it — before any shard sees it — when the request's cookie resolves to
 * anyone else, because the client cannot see the cookie it is about to replay
 * on.
 */

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const createWorkerWithSpy = () => {
    const reached: string[] = [];
    const namespace: ShardNamespaceLike = {
        get: (id) => {
            return {
                fetch: async () => {
                    reached.push((id as { __name: string }).__name);

                    return Response.json({ result: { ok: true } });
                },
            };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };
    const worker = createWorker({
        // The cookie names the user; no cookie is anonymous.
        resolveIdentity: (request): ResolvedIdentity | null => {
            const cookie = request.headers.get("cookie");

            return cookie === null ? null : { userId: cookie.replace("session=", "") };
        },
        shardDO: namespace,
    });

    return { reached, worker };
};

const request = (path: "/_lunora/rpc" | "/_lunora/rpc-batch", headers: Record<string, string>): Request =>
    new Request(`https://app.example${path}`, {
        body: JSON.stringify(
            path === "/_lunora/rpc" ? { args: {}, functionPath: "notes:add" } : { calls: [{ args: {}, functionPath: "notes:add", id: 0, mutationId: "m1" }] },
        ),
        // Same-origin, as a browser sends it: a cookie-bearing POST without
        // one is refused by the CSRF guard before identity is resolved.
        headers: { origin: "https://app.example", ...headers },
        method: "POST",
    });

describe("x-lunora-expect-subject", () => {
    it("lets a replay through when the cookie resolves to the user it names", async () => {
        expect.assertions(2);

        const { reached, worker } = createWorkerWithSpy();
        const response = await worker.fetch(
            request("/_lunora/rpc", { cookie: "session=user-a", [EXPECT_SUBJECT_HEADER]: encodeExpectedSubjectHeader("user-a") }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        expect(reached).toHaveLength(1);
    });

    it("refuses a replay whose cookie now belongs to another user, before any shard", async () => {
        expect.assertions(3);

        const { reached, worker } = createWorkerWithSpy();
        const response = await worker.fetch(
            request("/_lunora/rpc", { cookie: "session=user-b", [EXPECT_SUBJECT_HEADER]: encodeExpectedSubjectHeader("user-a") }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "IDENTITY_MISMATCH" } });
        expect(reached).toStrictEqual([]);
    });

    it("refuses a write queued signed out when someone is signed in, and the reverse", async () => {
        expect.assertions(2);

        const { worker } = createWorkerWithSpy();
        const signedIn = await worker.fetch(
            request("/_lunora/rpc", { cookie: "session=user-a", [EXPECT_SUBJECT_HEADER]: encodeExpectedSubjectHeader(null) }),
            {},
            fakeContext,
        );
        const signedOut = await worker.fetch(request("/_lunora/rpc", { [EXPECT_SUBJECT_HEADER]: encodeExpectedSubjectHeader("user-a") }), {}, fakeContext);

        expect(signedIn.status).toBe(409);
        expect(signedOut.status).toBe(409);
    });

    it("lets a signed-out replay through when the request is anonymous", async () => {
        expect.assertions(1);

        const { worker } = createWorkerWithSpy();
        const response = await worker.fetch(request("/_lunora/rpc", { [EXPECT_SUBJECT_HEADER]: encodeExpectedSubjectHeader(null) }), {}, fakeContext);

        expect(response.status).toBe(200);
    });

    it("refuses a whole batch whose cookie belongs to another user", async () => {
        expect.assertions(3);

        const { reached, worker } = createWorkerWithSpy();
        const response = await worker.fetch(
            request("/_lunora/rpc-batch", { cookie: "session=user-b", [EXPECT_SUBJECT_HEADER]: encodeExpectedSubjectHeader("user-a") }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "IDENTITY_MISMATCH" } });
        expect(reached).toStrictEqual([]);
    });

    it("refuses a malformed expectation rather than guessing", async () => {
        expect.assertions(2);

        const { reached, worker } = createWorkerWithSpy();
        const response = await worker.fetch(request("/_lunora/rpc", { cookie: "session=user-a", [EXPECT_SUBJECT_HEADER]: "not-base64-json" }), {}, fakeContext);

        expect(response.status).toBe(400);
        expect(reached).toStrictEqual([]);
    });

    it("leaves a request without the header alone", async () => {
        expect.assertions(1);

        const { worker } = createWorkerWithSpy();
        const response = await worker.fetch(request("/_lunora/rpc", { cookie: "session=user-b" }), {}, fakeContext);

        expect(response.status).toBe(200);
    });
});
