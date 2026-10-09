import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import type { ProvisionJob } from "../containers/provision/plan.mjs";
import { planJob } from "../containers/provision/plan.mjs";
import type { HaltStub } from "../src/deploy/halt-stub";
import { assertStubKeepsClasses, buildHaltStub, classesOf, haltedBody, mergeClasses, PARK_ALARM_MS, provisionableClasses } from "../src/deploy/halt-stub";
import { droppedDurableObjectClasses } from "../src/deploy/release";
import type { BindingRequirement, DeployManifest, TenantDeploymentSpec } from "../src/provision-contract";
import { BINDING_SUPPORT } from "../src/provision-contract";
import { deployJobSpec } from "../src/targets/provision-box/client";

/**
 * The emergency stop's stub release (`src/deploy/halt-stub.ts`). Its one job
 * besides stopping the tenant is data safety: on both Cloudflare targets a
 * converge deletes the data of a Durable Object class the new script stops
 * binding, so the stub must bind exactly the live release's classes. Checked
 * three ways — the manifest, the provision box's plan (what Alchemy actually
 * sees), and the module running.
 */

const LIVE: DeployManifest = {
    bindings: [
        { binding: "AI", type: "ai" },
        { binding: "ASSETS", type: "assets" },
        { binding: "COUNTER", className: "Counter", sqlite: true, type: "durable_object" },
        { binding: "DB", resource: "app-db", type: "d1" },
        { binding: "FILES", resource: "files", type: "r2" },
        { binding: "JOBS", resource: "jobs", type: "queue_producer" },
        { binding: "jobs", resource: "jobs", type: "queue_consumer" },
        { binding: "LEGACY", className: "LegacyRoom", sqlite: false, type: "durable_object" },
        { binding: "SESSIONS", type: "kv" },
        { binding: "SIGNUP", className: "SignupFlow", resource: "signup", type: "workflow" },
    ],
    compatibilityDate: "2026-05-01",
    compatibilityFlags: ["nodejs_compat", "no_global_navigator"],
};

const durableObjects = (manifest: DeployManifest): BindingRequirement[] => manifest.bindings.filter((binding) => binding.type === "durable_object");

/** The stub for a Worker that may run any of `manifests`, newest first — as the halt builds it from the recorded classes. */
const stubOf = (manifests: DeployManifest[], reason: string): HaltStub => {
    const [newest] = manifests;

    return buildHaltStub(mergeClasses(manifests.map((manifest) => classesOf(manifest))), {
        ...(newest?.compatibilityDate === undefined ? {} : { compatibilityDate: newest.compatibilityDate }),
        ...(newest?.compatibilityFlags === undefined ? {} : { compatibilityFlags: newest.compatibilityFlags }),
        reason,
    });
};

/** Load the stub module in node, its one workerd import replaced by a minimal `DurableObject` base. */
const loadStub = async (source: string): Promise<Record<string, unknown> & { default: { fetch: () => Response } }> => {
    const runnable = source.replace(
        /^import \{[^}]*\} from "cloudflare:workers";$/mu,
        "class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }\nclass WorkflowEntrypoint {}",
    );

    return import(`data:text/javascript;base64,${Buffer.from(runnable).toString("base64")}`) as Promise<
        Record<string, unknown> & { default: { fetch: () => Response } }
    >;
};

describe(buildHaltStub, () => {
    it("binds exactly the live release's Durable Object and Workflow classes — names, classes and storage flags", () => {
        const stub = stubOf([LIVE], "spend-cap");

        expect(classesOf(stub.manifest)).toStrictEqual(classesOf(LIVE));
        expect(durableObjects(stub.manifest)).toStrictEqual(durableObjects(LIVE));
        expect(stub.manifest.bindings.map((binding) => binding.type).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "durable_object",
            "durable_object",
            "workflow",
        ]);
    });

    it("drops every other binding — assets, storage, queues and their consumers — and keeps the compatibility settings", () => {
        const stub = stubOf([LIVE], "spend-cap");

        expect(stub.manifest.bindings.some((binding) => ["ai", "assets", "d1", "kv", "queue_consumer", "queue_producer", "r2"].includes(binding.type))).toBe(
            false,
        );
        expect(stub.manifest.compatibilityDate).toBe("2026-05-01");
        expect(stub.manifest.compatibilityFlags).toStrictEqual(["nodejs_compat", "no_global_navigator"]);
    });

    it("keeps the classes of every release that may be on the Worker, newest first for its settings", () => {
        const newer: DeployManifest = {
            bindings: [...LIVE.bindings, { binding: "PRESENCE", className: "Presence", sqlite: true, type: "durable_object" }],
            compatibilityDate: "2026-06-01",
        };
        const stub = stubOf([newer, LIVE], "manual");

        expect(
            classesOf(stub.manifest)
                .map((bound) => bound.className)
                .toSorted((a, b) => a.localeCompare(b)),
        ).toStrictEqual(["Counter", "LegacyRoom", "Presence", "SignupFlow"]);
        expect(stub.manifest.compatibilityDate).toBe("2026-06-01");
    });

    it("binds a class whose binding name another class took under a name of its own — data lives per class, not per binding", () => {
        const renamed: DeployManifest = { bindings: [{ binding: "COUNTER", className: "OtherCounter", sqlite: true, type: "durable_object" }] };
        const stub = stubOf([LIVE, renamed], "manual");

        expect(classesOf(stub.manifest).find((bound) => bound.className === "OtherCounter")?.binding).toBe("HALTED_CLASS_0");
        expect(classesOf(stub.manifest).find((bound) => bound.className === "Counter")?.binding).toBe("COUNTER");
    });

    it("keeps one entry per class whatever storage flag another release gave it — the flag is never sent, a class keeps its storage", () => {
        const restorage: DeployManifest = { bindings: [{ binding: "COUNTER", className: "Counter", sqlite: false, type: "durable_object" }] };

        expect(classesOf(stubOf([LIVE, restorage], "manual").manifest).filter((bound) => bound.className === "Counter")).toStrictEqual([
            { binding: "COUNTER", className: "Counter", sqlite: true, type: "durable_object" },
        ]);
    });

    it("binds nothing for a Worker with no classes", () => {
        expect(buildHaltStub([], { reason: "manual" }).manifest.bindings).toStrictEqual([]);
    });

    it.each([
        ["default", "a reserved export name"],
        ["1Counter", "a leading digit"],
        ["Counter-2", "a dash"],
        ['X } from "evil"; //', "an injection attempt"],
    ])("refuses the class name %j (%s) rather than write it into the module", (className) => {
        const manifest: DeployManifest = { bindings: [{ binding: "COUNTER", className, sqlite: true, type: "durable_object" }] };

        expect(() => stubOf([manifest], "manual")).toThrow(/is not one a Worker can export/u);
    });

    it("is a syntactically valid module that exports each class only as an alias of its own classes", () => {
        const { source } = stubOf(
            [{ bindings: [...LIVE.bindings, { binding: "RESPONSE", className: "Response", sqlite: true, type: "durable_object" }] }],
            "spend-cap",
        );
        const transpiled = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
            reportDiagnostics: true,
        });

        expect(transpiled.diagnostics).toStrictEqual([]);
        // A tenant class named like a global the stub uses must not shadow it.
        expect(source).not.toMatch(/^class (?:Counter|LegacyRoom|Response|SignupFlow)\b/mu);
        expect(source).toMatch(/^export \{ HaltedClass0 as Counter, HaltedClass1 as LegacyRoom, HaltedClass2 as Response, HaltedClass3 as SignupFlow \};$/mu);
        expect(source).not.toMatch(/scheduled|queue\(/u);
    });

    it("answers 503 with the reason, from the Worker and from every Durable Object class", async () => {
        const module = await loadStub(stubOf([LIVE], "spend-cap").source);
        const response = module.default.fetch();
        const Counter = module["Counter"] as new (ctx: unknown, env: unknown) => { fetch: () => Response };

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toStrictEqual({ error: "project halted: spend-cap" });
        expect(new Counter({}, {}).fetch().status).toBe(503);
        expect(haltedBody("overage")).toBe('{"error":"project halted: overage"}');
    });

    it("parks an alarm an hour out rather than running anything — and lets a failed re-arm throw so Cloudflare retries it", async () => {
        const module = await loadStub(stubOf([LIVE], "manual").source);
        const LegacyRoom = module["LegacyRoom"] as new (ctx: unknown, env: unknown) => { alarm: () => Promise<void> };
        const setAlarm = vi.fn<(at: number) => Promise<void>>(async () => undefined);
        const before = Date.now();

        await new LegacyRoom({ storage: { setAlarm } }, {}).alarm();

        expect(setAlarm).toHaveBeenCalledTimes(1);
        expect(setAlarm.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(before + PARK_ALARM_MS);

        const failing = vi.fn<(at: number) => Promise<void>>(async () => {
            throw new Error("storage unavailable");
        });

        await expect(new LegacyRoom({ storage: { setAlarm: failing } }, {}).alarm()).rejects.toThrow(/storage unavailable/u);
    });

    it("fails a Workflow instance that runs while halted, with the same message", async () => {
        const module = await loadStub(stubOf([LIVE], "support").source);
        const SignupFlow = module["SignupFlow"] as new () => { run: () => Promise<void> };

        await expect(new SignupFlow().run()).rejects.toThrow("project halted: support");
    });
});

describe(provisionableClasses, () => {
    it("drops a class of a type the target refuses — it never existed there", () => {
        const supported = (type: string): boolean => (BINDING_SUPPORT["cloudflare-wfp"] as Readonly<Record<string, string>>)[type] !== "unsupported";

        expect(provisionableClasses(classesOf(LIVE), supported).map((bound) => bound.className)).toStrictEqual(["Counter", "LegacyRoom"]);
    });
});

describe(assertStubKeepsClasses, () => {
    it("passes the generated stub", () => {
        expect(() => {
            assertStubKeepsClasses(stubOf([LIVE], "manual").manifest, classesOf(LIVE), droppedDurableObjectClasses);
        }).not.toThrow();
    });

    it("refuses a stub missing a class, naming the data the converge would delete", () => {
        const stub = stubOf([LIVE], "manual").manifest;
        const missing: DeployManifest = { ...stub, bindings: stub.bindings.filter((binding) => binding.className !== "LegacyRoom") };

        expect(() => {
            assertStubKeepsClasses(missing, classesOf(LIVE), droppedDurableObjectClasses);
        }).toThrow(/missing durable_object:LegacyRoom/u);
        expect(() => {
            assertStubKeepsClasses(missing, classesOf(LIVE), droppedDurableObjectClasses);
        }).toThrow(/would delete the data of LegacyRoom/u);
    });

    it("refuses a stub that adds a class, and ignores what does not decide data — the storage flag and the binding name", () => {
        const stub = stubOf([LIVE], "manual").manifest;
        const flipped: DeployManifest = {
            ...stub,
            bindings: stub.bindings.map((binding) => (binding.className === "Counter" ? { ...binding, sqlite: undefined } : binding)),
        };
        const renamed: DeployManifest = {
            ...stub,
            bindings: stub.bindings.map((binding) => (binding.className === "Counter" ? { ...binding, binding: "COUNTER_V2" } : binding)),
        };
        const extra: DeployManifest = { ...stub, bindings: [...stub.bindings, { binding: "NEW", className: "New", sqlite: true, type: "durable_object" }] };

        expect(() => {
            assertStubKeepsClasses(flipped, classesOf(LIVE), droppedDurableObjectClasses);
        }).not.toThrow();
        expect(() => {
            assertStubKeepsClasses(renamed, classesOf(LIVE), droppedDurableObjectClasses);
        }).not.toThrow();
        expect(() => {
            assertStubKeepsClasses(extra, classesOf(LIVE), droppedDurableObjectClasses);
        }).toThrow(/unexpected durable_object:New/u);
    });

    it("runs the rollback's own drop guard over the classes that may be on the Worker", () => {
        const dropped = vi.fn<typeof droppedDurableObjectClasses>(droppedDurableObjectClasses);
        const newer: DeployManifest = { bindings: [...LIVE.bindings, { binding: "PRESENCE", className: "Presence", sqlite: true, type: "durable_object" }] };
        const expected = mergeClasses([classesOf(newer), classesOf(LIVE)]);

        assertStubKeepsClasses(stubOf([newer, LIVE], "manual").manifest, expected, dropped);

        expect(dropped).toHaveBeenCalledTimes(1);
        expect(() => {
            assertStubKeepsClasses(stubOf([LIVE], "manual").manifest, expected, droppedDurableObjectClasses);
        }).toThrow(/would delete the data of Presence/u);
    });
});

/**
 * What Alchemy sees: the provision box's plan of the stub job against the plan
 * of the live job. The Worker's `durable_object` entries are what decide
 * `deleted_classes`, so they must be identical; on `cloudflare-workers` the stub
 * must also leave the Worker with no crons and no queue consumers.
 */
describe("the stub as the provision box plans it", () => {
    const ACCOUNT = { accountId: "a".repeat(32), apiToken: "tok", kind: "account" as const, state: { token: "s", url: "https://state.cell.workers.dev" } };
    const NAMESPACE = { cell: "cell-1", dispatchNamespace: "lunora-production", kind: "dispatch-namespace" as const };
    // Neither Cloudflare target provisions Workflows for a prebuilt bundle yet, so a live release there binds none.
    const LIVE_CF: DeployManifest = { ...LIVE, bindings: LIVE.bindings.filter((binding) => binding.type !== "workflow") };

    const spec = (manifest: DeployManifest, extra: Partial<TenantDeploymentSpec> = {}): TenantDeploymentSpec => {
        return {
            alias: "acme",
            bundle: new TextEncoder().encode("export default {}").buffer,
            deploymentId: "d1",
            kind: "production",
            manifest,
            secrets: {},
            tags: [],
            ...extra,
        };
    };

    const planOf = (target: "cloudflare-wfp" | "cloudflare-workers", tenant: TenantDeploymentSpec) =>
        planJob(
            {
                action: "deploy",
                spec: deployJobSpec(tenant, BINDING_SUPPORT[target], {
                    nativeCrons: target === "cloudflare-workers",
                    target: target === "cloudflare-workers" ? ACCOUNT : NAMESPACE,
                }),
            } as unknown as ProvisionJob,
            { controlPlaneScript: "lunora-cloud-production" },
        ).plan;

    it.each(["cloudflare-wfp", "cloudflare-workers"] as const)("binds the same Durable Object classes on %s as the live release", (target) => {
        const live = LIVE_CF;
        const livePlan = planOf(target, spec(live, { assets: { files: [{ content: "aGk=", path: "/index.html" }] } }));
        const stubPlan = planOf(target, spec(stubOf([live], "manual").manifest));
        const planned = (plan: typeof livePlan) => plan.worker?.bindings.filter((binding) => binding.kind === "durable_object");

        expect(planned(stubPlan)).toStrictEqual(planned(livePlan));
        expect(planned(stubPlan)).toHaveLength(2);
        expect(stubPlan.worker?.assets).toBeUndefined();
    });

    it("leaves a plain Worker with no cron triggers and no queue consumers, which the live release had", () => {
        const live = LIVE_CF;
        const livePlan = planOf("cloudflare-workers", spec(live, { assets: { files: [{ content: "aGk=", path: "/index.html" }] }, crons: ["*/5 * * * *"] }));
        const stubPlan = planOf("cloudflare-workers", spec(stubOf([live], "manual").manifest));

        expect(livePlan.worker?.crons).toStrictEqual(["*/5 * * * *"]);
        expect(livePlan.worker?.consumers).toHaveLength(1);
        expect(stubPlan.worker?.crons).toStrictEqual([]);
        expect(stubPlan.worker?.consumers).toStrictEqual([]);
        expect(stubPlan.project?.resources).toStrictEqual([]);
    });
});
