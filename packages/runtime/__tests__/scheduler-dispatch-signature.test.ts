import { describe, expect, it, vi } from "vitest";

import { SCHEDULER_SIGNATURE_TOLERANCE_MS, signSchedulerDispatch } from "../../../shared/scheduler-dispatch";
import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const SECRET = "scheduler-secret-for-tests";
const NOW = 1_700_000_000_000;
const PATH = "https://app.example/_lunora/scheduler/dispatch";
const BODY = JSON.stringify({ args: { n: 1 }, functionPath: "notes:add", id: "job-sig", shardKey: "tenant-a" });

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

/** A shard namespace that records the headers the Worker forwards to it. */
const recordingShard = (seen: Headers[]): ShardNamespaceLike => {
    return {
        get: () => {
            return {
                fetch: async (request: Request) => {
                    seen.push(new Headers(request.headers));

                    return Response.json({ result: null }, { status: 200 });
                },
            };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };
};

const post = (headers: Record<string, string>): Request =>
    new Request(PATH, {
        body: BODY,
        headers: { "content-type": "application/json", ...headers },
        method: "POST",
    });

const env = { LUNORA_SCHEDULER_SECRET: SECRET };

/** Runs one dispatch with `Date.now` pinned to `NOW`, restoring the clock afterwards. */
const dispatchAt = async (request: Request, seen: Headers[]): Promise<Response> => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);

    try {
        const worker = createWorker({ shardDO: recordingShard(seen) });

        return await worker.fetch(request, env, fakeContext);
    } finally {
        clock.mockRestore();
    }
};

describe("createWorker — scheduler dispatch signature", () => {
    it("accepts a fresh signature and forwards no identity the signature did not cover", async () => {
        expect.assertions(2);

        const seen: Headers[] = [];
        const signature = await signSchedulerDispatch(SECRET, { body: BODY, timestamp: NOW });
        const response = await dispatchAt(post({ "x-lunora-scheduler-signature": signature, "x-lunora-scheduler-timestamp": String(NOW) }), seen);

        expect(response.status).toBe(200);
        expect(seen[0]?.get("x-lunora-userid")).toBeNull();
    });

    it("refuses a signed request with an added x-lunora-userid header", async () => {
        expect.assertions(2);

        const seen: Headers[] = [];
        const signature = await signSchedulerDispatch(SECRET, { body: BODY, timestamp: NOW });
        const response = await dispatchAt(
            post({
                "x-lunora-scheduler-signature": signature,
                "x-lunora-scheduler-timestamp": String(NOW),
                "x-lunora-userid": "someone-else",
            }),
            seen,
        );

        expect(response.status).toBe(403);
        expect(seen).toHaveLength(0);
    });

    it("refuses a signature whose timestamp is outside the tolerance", async () => {
        expect.assertions(2);

        const seen: Headers[] = [];
        const stamp = NOW - SCHEDULER_SIGNATURE_TOLERANCE_MS - 1;
        const signature = await signSchedulerDispatch(SECRET, { body: BODY, timestamp: stamp });
        const response = await dispatchAt(post({ "x-lunora-scheduler-signature": signature, "x-lunora-scheduler-timestamp": String(stamp) }), seen);

        expect(response.status).toBe(403);
        expect(seen).toHaveLength(0);
    });
});
