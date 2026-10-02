import { LunoraError } from "@lunora/errors";
import { CELLD_CAPABILITIES } from "@lunora/platform";
import { describe, expect, it } from "vitest";

import type { DeployBackend } from "../src/deploy/release-core";
import { startRelease } from "../src/deploy/release-core";
import { CellScheduler } from "../src/deploy/scheduler";
import { TokenBucket } from "../src/deploy/token-bucket";
import type { BindingType, TargetId } from "../src/provision-contract";
import { BINDING_SUPPORT, TARGET_IDS, UNSUPPORTED_REASONS } from "../src/provision-contract";
import type { Placement } from "../src/targets/placement";
import { resolvePlacement } from "../src/targets/placement";
import { resolveTargetDriver, targetFleet } from "../src/targets/registry";
import memoryReleaseStore from "./_helpers/memory-release-store";
import { fakeDriver } from "./support/memory-driver";

/**
 * Per-target binding support (plan 458 §6, W3): each target's table, the
 * celld row's agreement with celld's own capability matrix, and the deploy
 * handler refusing by the PROJECT's target.
 */

type CapabilityKey = keyof typeof CELLD_CAPABILITIES.features;

/** Reads celld's rating of one feature; a feature the matrix omits counts as unsupported. */
const celldLevel = (feature: CapabilityKey): string => CELLD_CAPABILITIES.features[feature]?.level ?? "unsupported";

/** Maps each binding type to the matrix feature that rates it on a host, where one exists. */
const FEATURE_OF: Partial<Record<BindingType, CapabilityKey>> = {
    ai: "ai",
    analytics_engine: "analytics",
    browser: "browser",
    container: "containers",
    d1: "globalTables",
    durable_object: "shardedState",
    hyperdrive: "hyperdrive",
    images: "images",
    kv: "keyValueStore",
    pipeline: "pipelines",
    queue_consumer: "queues",
    queue_producer: "queues",
    r2: "objectStorage",
    vectorize: "vectorStore",
    workflow: "workflows",
};

/**
 * Where `celld-vps` refuses what celld itself can run — deliberately, each with
 * its reason. Adding a type here is a product decision; this list is what makes
 * it a visible one.
 */
const STRICTER_THAN_CELLD: Partial<Record<BindingType, string>> = {
    // The matrix rates `ai` emulated through an OpenAI-compatible proxy over
    // fetch. That is not an `env.AI` binding, which is what this type binds.
    ai: "no env.AI binding",
    // celld runs containers with Docker on the node; managed boxes stay Docker-free in v1 (plan 458 §9 Q5).
    container: "Docker-free boxes",
};

describe("bINDING_SUPPORT", () => {
    it.each(TARGET_IDS)("gives %s a reason for every type it refuses", (target) => {
        const table = BINDING_SUPPORT[target];
        const reasons = UNSUPPORTED_REASONS[target] as Partial<Record<BindingType, string>>;
        const refused = (Object.keys(table) as BindingType[]).filter((type) => table[type] === "unsupported");

        expect(refused.filter((type) => !reasons[type])).toStrictEqual([]);
    });

    it("rates the same binding types for every target", () => {
        const byName = (a: string, b: string): number => a.localeCompare(b);
        const types = Object.keys(BINDING_SUPPORT["cloudflare-wfp"]).toSorted(byName);

        for (const target of TARGET_IDS) {
            expect(Object.keys(BINDING_SUPPORT[target]).toSorted(byName)).toStrictEqual(types);
        }
    });

    it("words cloudflare-wfp's refusals for Workers for Platforms, and celld-vps's for celld", () => {
        expect(UNSUPPORTED_REASONS["cloudflare-wfp"].container).toContain("Workers for Platforms");
        expect(UNSUPPORTED_REASONS["celld-vps"].analytics_engine).toContain("celld");
    });
});

describe("cloudflare-workers against cloudflare-wfp", () => {
    const byo = BINDING_SUPPORT["cloudflare-workers"];
    const wfp = BINDING_SUPPORT["cloudflare-wfp"];

    it("binds everything Workers for Platforms does — a plain Worker in an account can take any binding a namespaced one can", () => {
        const wfpRuns = (Object.keys(wfp) as BindingType[]).filter((type) => wfp[type] !== "unsupported");

        expect(wfpRuns.filter((type) => byo[type] === "unsupported")).toStrictEqual([]);
    });

    it("consumes its own queues, so nothing is routed through the control plane", () => {
        expect(byo.queue_consumer).toBe("bound");
        expect(Object.values(byo)).not.toContain("routed");
    });

    it("words each refusal for the provision box or the manifest, never for Workers for Platforms", () => {
        for (const reason of Object.values(UNSUPPORTED_REASONS["cloudflare-workers"])) {
            expect(reason).not.toContain("Workers for Platforms");
        }
    });
});

describe("celld-vps agrees with celld's capability matrix", () => {
    const table = BINDING_SUPPORT["celld-vps"];
    const rated = Object.entries(FEATURE_OF) as [BindingType, CapabilityKey][];
    const celldRefuses = rated.filter(([, feature]) => celldLevel(feature) === "unsupported");
    const celldRuns = rated.filter(([type, feature]) => celldLevel(feature) !== "unsupported" && !(type in STRICTER_THAN_CELLD));

    it("rates at least one type each way, so neither check below is vacuous", () => {
        expect(celldRefuses.length).toBeGreaterThan(0);
        expect(celldRuns.length).toBeGreaterThan(0);
    });

    it.each(celldRefuses)("never supports %s, which celld rates unsupported (%s)", (type) => {
        expect(table[type]).toBe("unsupported");
    });

    it.each(celldRuns)("supports %s, which celld runs (%s)", (type) => {
        expect(table[type]).not.toBe("unsupported");
    });

    it("lists only real exceptions — each is a type celld does run", () => {
        for (const type of Object.keys(STRICTER_THAN_CELLD) as BindingType[]) {
            const feature = FEATURE_OF[type];

            expect(feature).toBeDefined();
            expect(feature === undefined ? "unsupported" : celldLevel(feature)).not.toBe("unsupported");
            expect(table[type]).toBe("unsupported");
        }
    });

    it("routes nothing through the control plane — celld delivers queues and crons itself", () => {
        expect(Object.values(table)).not.toContain("routed");
    });
});

describe("the registry", () => {
    it("builds each placement's driver, and each target's fleet, without touching an unconfigured env", () => {
        expect(resolveTargetDriver({ target: "cloudflare-wfp" }, {}).id).toBe("cloudflare-wfp");
        expect(resolveTargetDriver({ box: { id: "box_1", slug: "bslug000001" }, target: "celld-vps" }, {}).id).toBe("celld-vps");
        expect(targetFleet("cloudflare-wfp", {}).id).toBe("cloudflare-wfp");
        expect(targetFleet("celld-vps", {}).id).toBe("celld-vps");
        expect(
            resolveTargetDriver({ account: { accountId: "a".repeat(32), id: "cfa_1", workersSubdomain: "acme" }, target: "cloudflare-workers" }, {}).id,
        ).toBe("cloudflare-workers");
        expect(targetFleet("cloudflare-workers", {}).id).toBe("cloudflare-workers");
    });
});

describe("the deploy handler validates against the project's target", () => {
    const backend: DeployBackend = {
        createDeployment: () => Promise.reject(new Error("a refused release records nothing")),
        placement: () => Promise.resolve({ target: "cloudflare-wfp" }),
        releaseTarget: () => Promise.reject(new Error("unused")),
        rollbackDeployment: () => Promise.reject(new Error("unused")),
        updateStatus: () => Promise.resolve(),
        verifyKey: () => Promise.resolve(null),
    };

    const placements: Record<TargetId, Placement> = {
        "celld-vps": { box: { id: "box_1", slug: "bslug000001" }, target: "celld-vps" },
        "cloudflare-wfp": { target: "cloudflare-wfp" },
        "cloudflare-workers": { account: { accountId: "a".repeat(32), id: "cfa_1", workersSubdomain: "acme" }, target: "cloudflare-workers" },
    };

    const startOn = (target: TargetId, bindings: unknown[]) =>
        startRelease(
            { bundle: btoa("export default {}"), kind: "production", manifest: { bindings }, projectId: "proj_1", scriptName: "app" },
            { key: "k", organizationId: "org_1" },
            {
                backend: { ...backend, placement: () => Promise.resolve(placements[target]) },
                driverFor: () => fakeDriver(),
                releases: memoryReleaseStore().store,
                scheduler: new CellScheduler({ bucket: new TokenBucket({ capacity: 10, refillPerWindow: 10, windowMs: 1000 }) }),
            },
        );

    it("refuses on celld-vps what cloudflare-wfp binds, naming the binding and the target", async () => {
        await expect(startOn("celld-vps", [{ binding: "AI", type: "ai" }])).resolves.toStrictEqual({
            error: expect.stringMatching(/on the celld-vps target — ai \(AI\): Workers AI is not a celld binding/u) as string,
            status: 400,
        });
    });

    it("refuses on cloudflare-wfp what celld-vps runs", async () => {
        await expect(startOn("cloudflare-wfp", [{ binding: "FLOW", className: "OrderFlow", type: "workflow" }])).resolves.toMatchObject({
            error: expect.stringContaining("on the cloudflare-wfp target — workflow (FLOW): Workflows register per account script") as string,
            status: 400,
        });
    });

    it("refuses a celld-vps project that names no box before recording anything", async () => {
        const started = await startRelease(
            { bundle: btoa("export default {}"), kind: "production", projectId: "proj_1", scriptName: "app" },
            { key: "k", organizationId: "org_1" },
            {
                backend: { ...backend, placement: () => Promise.resolve(resolvePlacement({ target: "celld-vps" }, "default")) },
                driverFor: (placement) => resolveTargetDriver(placement, {}),
                releases: memoryReleaseStore().store,
                scheduler: new CellScheduler({ bucket: new TokenBucket({ capacity: 10, refillPerWindow: 10, windowMs: 1000 }) }),
            },
        );

        expect(started).toStrictEqual({ error: expect.stringContaining("names no box") as string, status: 409 });
    });

    it("refuses on cloudflare-workers what the provision box cannot bind, with its own reason", async () => {
        await expect(startOn("cloudflare-workers", [{ binding: "FLOW", className: "OrderFlow", type: "workflow" }])).resolves.toMatchObject({
            error: expect.stringContaining("on the cloudflare-workers target — workflow (FLOW): a plain Worker can run Workflows") as string,
            status: 400,
        });
    });

    it("refuses a cloudflare-workers project that names no connected account before recording anything", async () => {
        const started = await startRelease(
            { bundle: btoa("export default {}"), kind: "production", projectId: "proj_1", scriptName: "app" },
            { key: "k", organizationId: "org_1" },
            {
                backend: { ...backend, placement: () => Promise.resolve(resolvePlacement({ cellName: "default", target: "cloudflare-workers" }, "default")) },
                driverFor: (placement) => resolveTargetDriver(placement, {}),
                releases: memoryReleaseStore().store,
                scheduler: new CellScheduler({ bucket: new TokenBucket({ capacity: 10, refillPerWindow: 10, windowMs: 1000 }) }),
            },
        );

        expect(started).toStrictEqual({ error: expect.stringContaining("names no connected Cloudflare account") as string, status: 409 });
    });

    it("refuses a project placed on another cell before recording anything", async () => {
        const started = await startRelease(
            { bundle: btoa("export default {}"), kind: "production", projectId: "proj_1", scriptName: "app" },
            { key: "k", organizationId: "org_1" },
            {
                backend: { ...backend, placement: () => Promise.reject(new LunoraError("CONFLICT", 'placed on cell "eu-1"')) },
                driverFor: () => fakeDriver(),
                releases: memoryReleaseStore().store,
                scheduler: new CellScheduler({ bucket: new TokenBucket({ capacity: 10, refillPerWindow: 10, windowMs: 1000 }) }),
            },
        );

        expect(started).toStrictEqual({ error: 'placed on cell "eu-1"', status: 409 });
    });
});
