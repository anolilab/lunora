import { describe, expect, it, vi } from "vitest";

import { HALTED_REFUSAL } from "../src/deploy/halt";
import type { BoundClass } from "../src/deploy/halt-stub";
import { handleDeployRequest } from "../src/deploy/handler";
import { createDeployPacer } from "../src/deploy/pacing";
import type { DeployBackend } from "../src/deploy/release-core";
import { guardedDriver } from "../src/deploy/routes/deploy";
import type { LunoraActionContext } from "../src/deploy/routes/shared";
import type { ConvergeOutcome } from "../src/deploy/worker-classes";
import { beginConverge, classesOnWorker, endConverge } from "../src/deploy/worker-classes";
import type { TenantDeploymentSpec } from "../src/provision-contract";
import memoryReleaseStore from "./_helpers/memory-release-store";
import { fakeDriver } from "./support/memory-driver";
import type { MemoryStore } from "./support/memory-store";
import { memoryStore } from "./support/memory-store";

/**
 * The deploy edge's driver (`guardedDriver`): the last check before anything
 * lands on an alias's Worker — a deploy, revert or rollback already queued when
 * an emergency stop was asked for must not land on top of the stub — and the
 * record of which classes each converge put there. The up-front refusals
 * (`deployments.create`, `releaseTarget`, `rollback`) are in
 * `halts-functions.test.ts`; this is the converge-time one, on the real deploy core.
 */

/** The ownership rows the class record lives on. */
const recordStore = (): MemoryStore => memoryStore({ aliasOwnership: [{ _id: "ao_app", alias: "app", organizationId: "org_1", projectId: "proj_1" }] });

/**
 * A Lunora context whose `halts.aliasHalted` answers from `halted`, and whose
 * `halts.beginConverge` / `endConverge` write the class record into `store`
 * (or fail, with `failRecord`).
 */
const contextOf = (halted: Set<string>, store: MemoryStore = recordStore(), failRecord = false): LunoraActionContext => {
    return {
        runAction: async () => undefined as never,
        runMutation: async <R>(_reference: unknown, args?: Record<string, unknown>) => {
            if (failRecord) {
                throw new Error("D1 unavailable");
            }

            const input = args as { alias: string; classes: BoundClass[]; now: number; outcome?: ConvergeOutcome; startedAt?: number; token: string };

            await (input.outcome === undefined
                ? beginConverge(store, input)
                : endConverge(store, { ...input, outcome: input.outcome, startedAt: input.startedAt ?? input.now }));

            return null as R;
        },
        runQuery: async <R>(_reference: unknown, args?: Record<string, unknown>) => halted.has(String(args?.["alias"])) as R,
    };
};

const capture = () => {
    const deployed: string[] = [];
    const deploy = vi.fn<(spec: TenantDeploymentSpec) => Promise<{ url: string }>>(async (spec) => {
        deployed.push(new TextDecoder().decode(spec.bundle));

        return { url: `https://${spec.alias}.lunora.app` };
    });

    return { deploy, deployed };
};

const backend = (overrides: Partial<DeployBackend> = {}): DeployBackend => {
    return {
        createDeployment: async () => {
            return { deploymentId: "dep_new", previousDeploymentId: "dep_prev", version: 2 };
        },
        placement: async () => {
            return { target: "cloudflare-wfp" };
        },
        releaseTarget: async () => {
            return {
                adminToken: "admin-prev",
                alias: "app",
                kind: "production",
                organizationId: "org_1",
                projectId: "proj_1",
                target: "cloudflare-wfp",
            };
        },
        rollbackDeployment: async () => {
            return { scriptName: "app", version: 1 };
        },
        updateStatus: async () => undefined,
        verifyKey: async () => {
            return { organizationId: "org_1", projectId: "proj_1", type: "production" as const };
        },
        ...overrides,
    };
};

const deployRequest = (): Request =>
    new Request("https://cloud/v1/deploy", {
        body: JSON.stringify({ bundle: btoa("export default { v: 2 }"), projectId: "proj_1", scriptName: "app" }),
        headers: { authorization: "Bearer k", "content-type": "application/json" },
        method: "POST",
    });

const lines = async (response: Response): Promise<Record<string, unknown>[]> => {
    const text = await response.text();

    return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
};

const classNamesOf = (record: { classes: BoundClass[] }): string[] => record.classes.map((bound) => bound.className);

const spec = (alias: string, classes: string[] = []): TenantDeploymentSpec => {
    return {
        alias,
        bundle: new ArrayBuffer(0),
        deploymentId: "d",
        kind: "production",
        manifest: {
            bindings: classes.map((className) => {
                return { binding: className.toUpperCase(), className, sqlite: true, type: "durable_object" as const };
            }),
        },
        secrets: {},
        tags: [],
    };
};

describe("the class record each converge writes", () => {
    it("confirms the classes a converge put on the Worker", async () => {
        const store = recordStore();
        const driver = guardedDriver(
            contextOf(new Set(), store),
            fakeDriver({
                deploy: async () => {
                    return { url: "https://app.test" };
                },
            }),
        );

        await driver.deploy(spec("app", ["Counter", "Presence"]));

        await expect(classesOnWorker(store, "app")).resolves.toMatchObject({ recorded: true });
        expect(classNamesOf(await classesOnWorker(store, "app"))).toStrictEqual(["Counter", "Presence"]);
        expect(store.tables["aliasOwnership"]?.[0]?.["pendingClasses"]).toStrictEqual([]);
    });

    it("keeps the classes of a converge that failed after it may have uploaded, and drops one that provably uploaded nothing", async () => {
        const store = recordStore();
        const ok = guardedDriver(
            contextOf(new Set(), store),
            fakeDriver({
                deploy: async () => {
                    return { url: "https://app.test" };
                },
            }),
        );
        const failing = (message: string) =>
            guardedDriver(
                contextOf(new Set(), store),
                fakeDriver({
                    deploy: async () => {
                        throw new Error(message);
                    },
                }),
            );

        await ok.deploy(spec("app", ["Counter"]));

        await expect(failing("alchemy deploy of lunora-project-app failed with exit code 1").deploy(spec("app", ["Counter", "Early"]))).rejects.toThrow(
            /project/u,
        );
        await expect(failing("alchemy deploy of lunora-worker-app failed with exit code 1").deploy(spec("app", ["Counter", "Late"]))).rejects.toThrow(
            /worker/u,
        );

        expect(classNamesOf(await classesOnWorker(store, "app"))).toStrictEqual(["Counter", "Late"]);

        // A later success is what the Worker runs: the failure before it no longer counts.
        await ok.deploy(spec("app", ["Counter"]));

        expect(classNamesOf(await classesOnWorker(store, "app"))).toStrictEqual(["Counter"]);
    });

    it("records a success with its own classes even when its pending entry was overwritten meanwhile", async () => {
        const store = recordStore();
        const driver = guardedDriver(
            contextOf(new Set(), store),
            fakeDriver({
                deploy: async () => {
                    // A concurrent read-modify-write of the ownership row lost this converge's pending entry.
                    await store.patch("ao_app", { pendingClasses: [] });

                    return { url: "https://app.test" };
                },
            }),
        );

        await driver.deploy(spec("app", ["Counter", "Presence"]));

        expect(classNamesOf(await classesOnWorker(store, "app"))).toStrictEqual(["Counter", "Presence"]);
    });

    it("keeps a failure's classes even when its pending entry was overwritten meanwhile", async () => {
        const store = recordStore();
        const driver = guardedDriver(
            contextOf(new Set(), store),
            fakeDriver({
                deploy: async () => {
                    await store.patch("ao_app", { pendingClasses: [] });

                    throw new Error("alchemy deploy of lunora-worker-app failed with exit code 1");
                },
            }),
        );

        await expect(driver.deploy(spec("app", ["Counter", "Presence"]))).rejects.toThrow(/worker/u);
        expect(classNamesOf(await classesOnWorker(store, "app"))).toStrictEqual(["Counter", "Presence"]);
    });

    it("refuses the converge when the record cannot be written — it fails closed", async () => {
        const { deploy } = capture();
        const driver = guardedDriver(contextOf(new Set(), recordStore(), true), fakeDriver({ deploy }));

        await expect(driver.deploy(spec("app", ["Counter"]))).rejects.toThrow(/D1 unavailable/u);
        expect(deploy).not.toHaveBeenCalled();
    });
});

describe(guardedDriver, () => {
    it("refuses to converge onto a halted alias, and passes any other through", async () => {
        const { deploy } = capture();
        const driver = guardedDriver(
            contextOf(new Set(["app"]), memoryStore({ aliasOwnership: [{ _id: "ao_other", alias: "other", projectId: "p_o" }] })),
            fakeDriver({ deploy }),
        );

        await expect(driver.deploy(spec("app"))).rejects.toThrow(HALTED_REFUSAL);
        expect(deploy).not.toHaveBeenCalled();
        await expect(driver.deploy(spec("other"))).resolves.toStrictEqual({ url: "https://other.lunora.app" });
    });

    it("fails a deploy whose converge comes up after the halt, before anything reaches the Worker", async () => {
        const { deploy, deployed } = capture();
        const response = await handleDeployRequest(deployRequest(), {
            backend: backend(),
            driverFor: () => guardedDriver(contextOf(new Set(["app"])), fakeDriver({ deploy })),
            pacer: createDeployPacer(),
            releases: memoryReleaseStore().store,
        });
        const frames = await lines(response);

        expect(deployed).toStrictEqual([]);
        expect(frames).toContainEqual(expect.objectContaining({ error: HALTED_REFUSAL, phase: "failed" }));
        // It never reached the Worker, so there is nothing to revert — and nothing tries.
        expect(frames.some((frame) => String(frame["event"]).includes("revert"))).toBe(false);
    });

    it("never lets a failed health check's revert land on the stub", async () => {
        const { deploy, deployed } = capture();
        const halted = new Set<string>();
        const { store } = memoryReleaseStore();

        await store.put("dep_prev", { bundle: btoa("export default { v: 1 }"), manifest: { bindings: [] } });

        const response = await handleDeployRequest(deployRequest(), {
            backend: backend(),
            driverFor: () => guardedDriver(contextOf(halted), fakeDriver({ deploy })),
            // The halt is asked for, and its stub converged, while the release is being verified: the dispatcher answers 503.
            healthCheck: async () => {
                halted.add("app");
                deployed.push("export default { halted: true }");

                return false;
            },
            pacer: createDeployPacer(),
            releases: store,
        });
        const frames = await lines(response);

        expect(deployed).toStrictEqual(["export default { v: 2 }", "export default { halted: true }"]);
        expect(frames).toContainEqual(expect.objectContaining({ error: HALTED_REFUSAL, event: "revert_failed", to: "dep_prev" }));
        expect(frames.at(-1)).toMatchObject({ done: true, status: "failed" });
    });
});
