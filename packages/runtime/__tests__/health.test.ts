import { describe, expect, it } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { HealthBody } from "../src/health-routes";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

/** A DO namespace whose stub answers every request (reachable). */
const reachableNamespace: ShardNamespaceLike = {
    get: () => {return { fetch: async () => new Response("ok", { status: 404 }) }},
    idFromName: (name) => {return { __name: name }},
};

/** A DO namespace whose stub throws on fetch (unreachable). */
const unreachableNamespace: ShardNamespaceLike = {
    get: () => {return {
        fetch: async () => {
            throw new Error("DO unreachable — connection refused to secret-host.internal");
        },
    }},
    idFromName: (name) => {return { __name: name }},
};

/** A fake D1 binding whose `SELECT 1` resolves (healthy). */
const healthyD1 = (): unknown => {return {
    batch: async () => [],
    dump: async () => new ArrayBuffer(0),
    prepare: () => {return { first: async () => {return { 1: 1 }} }},
}};

/** A fake D1 binding whose `SELECT 1` rejects (down) — the error message embeds a "secret" to prove non-leakage. */
const downD1 = (): unknown => {return {
    batch: async () => [],
    dump: async () => new ArrayBuffer(0),
    prepare: () => {return {
        first: async () => {
            throw new Error("connection to postgres://user:sup3rs3cr3t@db failed");
        },
    }},
}};

const get = (path: string): Request => new Request(`https://app.example${path}`, { method: "GET" });

describe("createWorker — health / readiness endpoints", () => {
    it("returns 200 + healthy when the DO is reachable and D1 resolves", async () => {
        expect.assertions(4);

        const worker = createWorker({ shardDO: reachableNamespace });
        const response = await worker.fetch(get("/_lunora/health"), { DB: healthyD1() }, fakeContext);

        expect(response.status).toBe(200);

        const body: HealthBody = JSON.parse(await response.text());

        expect(body.status).toBe("healthy");
        expect(body.checks.find((c) => c.name === "durable-object")?.status).toBe("up");
        expect(body.checks.find((c) => c.name === "d1:DB")?.status).toBe("up");
    });

    it("returns 503 + unhealthy when a critical dependency (D1) is down", async () => {
        expect.assertions(3);

        const worker = createWorker({ shardDO: reachableNamespace });
        const response = await worker.fetch(get("/_lunora/health"), { DB: downD1() }, fakeContext);

        expect(response.status).toBe(503);

        const body: HealthBody = JSON.parse(await response.text());

        expect(body.status).toBe("unhealthy");
        expect(body.checks.find((c) => c.name === "d1:DB")?.status).toBe("down");
    });

    it("returns 503 when the Durable Object is unreachable", async () => {
        expect.assertions(2);

        const worker = createWorker({ shardDO: unreachableNamespace });
        const response = await worker.fetch(get("/_lunora/health"), {}, fakeContext);

        expect(response.status).toBe(503);

        const body: HealthBody = JSON.parse(await response.text());

        expect(body.status).toBe("unhealthy");
    });

    it("never leaks a secret / PII in the public health body (messages redacted)", async () => {
        expect.assertions(2);

        const worker = createWorker({ shardDO: unreachableNamespace });
        const response = await worker.fetch(get("/_lunora/health"), { DB: downD1() }, fakeContext);
        const raw = await response.text();

        // The probe error messages embed a fake secret; in the default public
        // posture no per-check message is surfaced, so it must not appear.
        expect(raw).not.toContain("sup3rs3cr3t");
        expect(raw).not.toContain("secret-host.internal");
    });

    it("surfaces runtime-authored messages only under the admin posture (still no user secret)", async () => {
        expect.assertions(3);

        const worker = createWorker({ adminToken: "tok", health: { auth: "admin" }, shardDO: reachableNamespace });

        // Unauthenticated → 403.
        const denied = await worker.fetch(get("/_lunora/health"), { DB: downD1() }, fakeContext);

        expect(denied.status).toBe(403);

        // With the admin bearer → served, and the runtime-authored message appears
        // (but never the user's connection-string secret from the raw error).
        const ok = await worker.fetch(
            new Request("https://app.example/_lunora/health", { headers: { authorization: "Bearer tok" }, method: "GET" }),
            { DB: downD1() },
            fakeContext,
        );
        const raw = await ok.text();

        expect(raw).toContain("d1 query failed");
        expect(raw).not.toContain("sup3rs3cr3t");
    });

    it("readiness gate reports R2 / queue / Hyperdrive presence checks", async () => {
        expect.assertions(3);

        const worker = createWorker({ shardDO: reachableNamespace });
        const env = {
            BUCKET: { createMultipartUpload: () => undefined, head: () => undefined, list: () => undefined },
            HYPERDRIVE: { connectionString: "postgres://redacted" },
            QUEUE: { send: () => undefined, sendBatch: () => undefined },
        };
        const response = await worker.fetch(get("/_lunora/health/ready"), env, fakeContext);

        expect(response.status).toBe(200);

        const body: HealthBody = JSON.parse(await response.text());

        expect(body.checks.map((check) => check.name)).toEqual(expect.arrayContaining(["r2:BUCKET", "queue:QUEUE", "hyperdrive:HYPERDRIVE"]));
        // Hyperdrive connection string must never appear in the body.
        expect(JSON.stringify(body)).not.toContain("postgres://redacted");
    });
});
