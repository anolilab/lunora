import { CELLD_CAPABILITIES } from "@lunora/platform";
import { describe, expect, it } from "vitest";

import type { DeployBackend } from "../src/deploy/handler";
import { startRelease } from "../src/deploy/handler";
import { CellScheduler } from "../src/deploy/scheduler";
import { TokenBucket } from "../src/deploy/token-bucket";
import type { BindingType, TargetId } from "../src/provision-contract";
import { BINDING_SUPPORT, TARGET_IDS, UNSUPPORTED_REASONS } from "../src/provision-contract";
import { resolveTargetDriver } from "../src/targets/registry";
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
    it("builds cloudflare-wfp over its own row of the table", () => {
        const driver = resolveTargetDriver("cloudflare-wfp", {});

        expect(driver.bindingSupport).toBe(BINDING_SUPPORT["cloudflare-wfp"]);
        expect(driver.unsupportedReasons).toBe(UNSUPPORTED_REASONS["cloudflare-wfp"]);
    });

    it("refuses a target with a table but no driver yet, rather than falling back", () => {
        expect(() => resolveTargetDriver("celld-vps", {})).toThrow(/celld-vps.*no driver/u);
    });
});

describe("the deploy handler validates against the project's target", () => {
    const backend: DeployBackend = {
        createDeployment: () => Promise.reject(new Error("a refused release records nothing")),
        releaseTarget: () => Promise.reject(new Error("unused")),
        rollbackDeployment: () => Promise.reject(new Error("unused")),
        updateStatus: () => Promise.resolve(),
        verifyKey: () => Promise.resolve(null),
    };

    const startOn = (target: TargetId, bindings: unknown[]) =>
        startRelease(
            { bundle: btoa("export default {}"), kind: "production", manifest: { bindings }, projectId: "proj_1", scriptName: "app" },
            { key: "k", organizationId: "org_1" },
            {
                backend,
                driverFor: () => fakeDriver({ bindingSupport: BINDING_SUPPORT[target], id: target, unsupportedReasons: UNSUPPORTED_REASONS[target] }),
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

    it("refuses a project whose target has no driver before recording anything", async () => {
        const started = await startRelease(
            { bundle: btoa("export default {}"), kind: "production", projectId: "proj_1", scriptName: "app" },
            { key: "k", organizationId: "org_1" },
            {
                backend,
                driverFor: (target) => resolveTargetDriver(target === "cloudflare-wfp" ? "celld-vps" : target, {}),
                releases: memoryReleaseStore().store,
                scheduler: new CellScheduler({ bucket: new TokenBucket({ capacity: 10, refillPerWindow: 10, windowMs: 1000 }) }),
            },
        );

        expect(started).toStrictEqual({ error: expect.stringContaining("celld-vps") as string, status: 501 });
    });
});
