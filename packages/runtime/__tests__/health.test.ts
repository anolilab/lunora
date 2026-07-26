import { describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { HealthBody, HealthProbe } from "../src/health-routes";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

/** A DO namespace whose stub answers every request (reachable). */
const reachableNamespace: ShardNamespaceLike = {
    get: () => {
        return { fetch: async () => new Response("ok", { status: 404 }) };
    },
    idFromName: (name) => {
        return { __name: name };
    },
};

/** A DO namespace whose stub throws on fetch (unreachable). */
const unreachableNamespace: ShardNamespaceLike = {
    get: () => {
        return {
            fetch: async () => {
                throw new Error("DO unreachable — connection refused to secret-host.internal");
            },
        };
    },
    idFromName: (name) => {
        return { __name: name };
    },
};

/** A fake D1 binding whose `SELECT 1` resolves (healthy). */
const healthyD1 = (): unknown => {
    return {
        batch: async () => [],
        dump: async () => new ArrayBuffer(0),
        prepare: () => {
            return {
                first: async () => {
                    return { 1: 1 };
                },
            };
        },
    };
};

/** A fake D1 binding whose `SELECT 1` rejects (down) — the error message embeds a "secret" to prove non-leakage. */
const downD1 = (): unknown => {
    return {
        batch: async () => [],
        dump: async () => new ArrayBuffer(0),
        prepare: () => {
            return {
                first: async () => {
                    throw new Error("connection to postgres://user:sup3rs3cr3t@db failed");
                },
            };
        },
    };
};

const get = (path: string): Request => new Request(`https://app.example${path}`, { method: "GET" });

/** A probe that counts how many times it ran, proving whether the live probes re-ran between requests. `kind: "both"` (default) so it runs on both endpoints. */
const makeCountingProbe = (): { probe: HealthProbe; runs: () => number } => {
    let runs = 0;

    return {
        probe: {
            check: () => {
                runs += 1;

                return { healthy: true };
            },
            critical: false,
            name: "counter",
        },
        runs: () => runs,
    };
};

describe("createWorker — health / readiness endpoints", () => {
    it("returns 200 + healthy when the DO is reachable and D1 resolves", async () => {
        expect.assertions(4);

        const worker = createWorker({ shardDO: reachableNamespace });
        const response = await worker.fetch(get("/_lunora/health"), { DB: healthyD1() }, fakeContext);

        expect(response.status).toBe(200);

        const body: HealthBody = JSON.parse(await response.text());

        expect(body.status).toBe("healthy");
        expect(body.checks.find((c) => c.name === "durable-object")?.status).toBe("up");
        // Public posture: the D1 check surfaces as its redacted kind `d1`, never the `DB` binding key.
        expect(body.checks.find((c) => c.name === "d1")?.status).toBe("up");
    });

    it("returns 503 + unhealthy when a critical dependency (D1) is down", async () => {
        expect.assertions(3);

        const worker = createWorker({ shardDO: reachableNamespace });
        const response = await worker.fetch(get("/_lunora/health"), { DB: downD1() }, fakeContext);

        expect(response.status).toBe(503);

        const body: HealthBody = JSON.parse(await response.text());

        expect(body.status).toBe("unhealthy");
        expect(body.checks.find((c) => c.name === "d1")?.status).toBe("down");
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

        // Public posture: presence checks surface as their redacted kinds, never the binding keys.
        expect(body.checks.map((check) => check.name)).toEqual(expect.arrayContaining(["r2", "queue", "hyperdrive"]));
        // Hyperdrive connection string must never appear in the body.
        expect(JSON.stringify(body)).not.toContain("postgres://redacted");
    });

    it("redacts the configured binding key from the public body but keeps it under admin", async () => {
        expect.assertions(2);

        // Public posture: a D1 binding named `SECRET_DB` must surface only as `d1`.
        const publicWorker = createWorker({ shardDO: reachableNamespace });
        const publicResponse = await publicWorker.fetch(get("/_lunora/health"), { SECRET_DB: healthyD1() }, fakeContext);
        const publicRaw = await publicResponse.text();

        expect(publicRaw).not.toContain("SECRET_DB");

        // Admin posture: the full `d1:SECRET_DB` name is retained for the operator.
        const adminWorker = createWorker({ adminToken: "tok", health: { auth: "admin" }, shardDO: reachableNamespace });
        const adminResponse = await adminWorker.fetch(
            new Request("https://app.example/_lunora/health", { headers: { authorization: "Bearer tok" }, method: "GET" }),
            { SECRET_DB: healthyD1() },
            fakeContext,
        );
        const adminRaw = await adminResponse.text();

        expect(adminRaw).toContain("d1:SECRET_DB");
    });

    it("caches the public report across requests within the TTL, and re-runs when disabled", async () => {
        expect.assertions(2);

        const cached = makeCountingProbe();
        const cachedWorker = createWorker({ health: { cacheTtlMs: 60_000, probes: [cached.probe] }, shardDO: reachableNamespace });

        await cachedWorker.fetch(get("/_lunora/health"), {}, fakeContext);
        await cachedWorker.fetch(get("/_lunora/health"), {}, fakeContext);

        expect(cached.runs()).toBe(1);

        const uncached = makeCountingProbe();
        const uncachedWorker = createWorker({ health: { cacheTtlMs: 0, probes: [uncached.probe] }, shardDO: reachableNamespace });

        await uncachedWorker.fetch(get("/_lunora/health"), {}, fakeContext);
        await uncachedWorker.fetch(get("/_lunora/health"), {}, fakeContext);

        expect(uncached.runs()).toBe(2);
    });

    it("re-runs the probes once the cache TTL has expired", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        try {
            let runs = 0;
            const probe: HealthProbe = {
                check: () => {
                    runs += 1;

                    return { healthy: true };
                },
                critical: false,
                name: "counter",
            };
            const worker = createWorker({ health: { cacheTtlMs: 1000, probes: [probe] }, shardDO: reachableNamespace });

            await worker.fetch(get("/_lunora/health"), {}, fakeContext);

            expect(runs).toBe(1);

            await worker.fetch(get("/_lunora/health"), {}, fakeContext);

            expect(runs).toBe(1);

            vi.advanceTimersByTime(1001);

            await worker.fetch(get("/_lunora/health"), {}, fakeContext);

            expect(runs).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not cache the readiness gate by default while the aggregate probe caches (public)", async () => {
        expect.assertions(2);

        // No `cacheTtlMs` → the aggregate probe defaults to a 5s public cache…
        const aggregate = makeCountingProbe();
        const aggregateWorker = createWorker({ health: { probes: [aggregate.probe] }, shardDO: reachableNamespace });

        await aggregateWorker.fetch(get("/_lunora/health"), {}, fakeContext);
        await aggregateWorker.fetch(get("/_lunora/health"), {}, fakeContext);

        expect(aggregate.runs()).toBe(1);

        // …but the readiness gate must NOT inherit that default cache: a k8s / LB
        // readiness poll must re-run the probes on every call so it sees a
        // dependency go down immediately, not up to 5s later.
        const readiness = makeCountingProbe();
        const readinessWorker = createWorker({ health: { probes: [readiness.probe] }, shardDO: reachableNamespace });

        await readinessWorker.fetch(get("/_lunora/health/ready"), {}, fakeContext);
        await readinessWorker.fetch(get("/_lunora/health/ready"), {}, fakeContext);

        expect(readiness.runs()).toBe(2);
    });

    it("caches the readiness gate when the operator sets cacheTtlMs explicitly", async () => {
        expect.assertions(1);

        let runs = 0;
        const probe: HealthProbe = {
            check: () => {
                runs += 1;

                return { healthy: true };
            },
            critical: false,
            name: "counter",
        };
        const worker = createWorker({ health: { cacheTtlMs: 60_000, probes: [probe] }, shardDO: reachableNamespace });

        await worker.fetch(get("/_lunora/health/ready"), {}, fakeContext);
        await worker.fetch(get("/_lunora/health/ready"), {}, fakeContext);

        // An explicit TTL overrides the readiness default and re-enables caching.
        expect(runs).toBe(1);
    });

    it("redacts a colon-less custom probe name in the public posture but keeps it under admin", async () => {
        expect.assertions(3);

        const customProbe: HealthProbe = {
            check: () => {
                return { healthy: true };
            },
            critical: false,
            // An operator-supplied name with no `kind:` prefix — must not reach an
            // unauthenticated caller verbatim.
            name: "acme-prod-billing",
        };

        const publicWorker = createWorker({ health: { probes: [customProbe] }, shardDO: reachableNamespace });
        const publicResponse = await publicWorker.fetch(get("/_lunora/health"), {}, fakeContext);
        const publicRaw = await publicResponse.text();

        expect(publicRaw).not.toContain("acme-prod-billing");

        const publicBody: HealthBody = JSON.parse(publicRaw);

        // Redacted to the generic `probe` label instead of leaking the raw name.
        expect(publicBody.checks.some((check) => check.name === "probe")).toBe(true);

        const adminWorker = createWorker({ adminToken: "tok", health: { auth: "admin", probes: [customProbe] }, shardDO: reachableNamespace });
        const adminResponse = await adminWorker.fetch(
            new Request("https://app.example/_lunora/health", { headers: { authorization: "Bearer tok" }, method: "GET" }),
            {},
            fakeContext,
        );
        const adminRaw = await adminResponse.text();

        // Admin posture keeps the full operator-supplied name.
        expect(adminRaw).toContain("acme-prod-billing");
    });
});
