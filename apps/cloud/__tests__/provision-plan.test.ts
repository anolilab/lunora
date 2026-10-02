import { describe, expect, it } from "vitest";

import type { ProvisionJob } from "../containers/provision/plan.mjs";
import { assetRelativePath, DEFAULT_COMPATIBILITY_DATE, PlanError, planJob } from "../containers/provision/plan.mjs";
import type { BindingRequirement } from "../src/provision-contract";
import { BINDING_SUPPORT as BINDING_SUPPORT_BY_TARGET, tenantResourceName } from "../src/provision-contract";

/**
 * The provision box's job → plan mapping. The plan is the only thing the
 * static Alchemy program reads, so every tenant-controlled value is checked
 * here, and resource names are the control plane's (`tenantResourceName`),
 * carried on each binding as `resourceName`.
 */

const ALIAS = "acme";

/** The box provisions for `cloudflare-wfp` only; its table is the contract this mapping honours. */
const BINDING_SUPPORT = BINDING_SUPPORT_BY_TARGET["cloudflare-wfp"];

/** What the control plane sends: provisioned bindings carry their resource name. */
const withName = (requirement: BindingRequirement): BindingRequirement & { resourceName?: string } =>
    BINDING_SUPPORT[requirement.type] === "provisioned" ? { ...requirement, resourceName: tenantResourceName(ALIAS, requirement) } : requirement;

type DeployJob = Extract<ProvisionJob, { action: "deploy" }>;

const deployJob = (bindings: BindingRequirement[], overrides: Partial<DeployJob["spec"]> = {}): DeployJob => {
    return {
        action: "deploy",
        spec: {
            alias: ALIAS,
            bundle: Buffer.from("export default {}").toString("base64"),
            cell: "cell-1",
            dispatchNamespace: "lunora-production",
            manifest: { bindings: bindings.map((requirement) => withName(requirement)) },
            secrets: {},
            tags: ["org:o1", "project:p1", "env:production"],
            ...overrides,
        },
    };
};

const plan = (job: ProvisionJob) => planJob(job, { controlPlaneScript: "lunora-cloud-production" });

const refuse = (job: ProvisionJob, message: RegExp) => {
    expect(() => plan(job)).toThrow(PlanError);
    expect(() => plan(job)).toThrow(message);
};

describe("provision plan: deploy", () => {
    it("orders the project stack before the Worker, both on the namespace stage", () => {
        expect.assertions(2);

        const result = plan(deployJob([]));

        expect(result.stage).toBe("lunora-production");
        expect(result.steps).toStrictEqual([
            { kind: "project", op: "deploy", stackName: "lunora-project-acme" },
            { kind: "worker", op: "deploy", stackName: "lunora-worker-acme" },
        ]);
    });

    it("names the Worker by the alias, so every release converges the same script and keeps its Durable Object data", () => {
        expect.assertions(2);

        const first = plan(deployJob([{ binding: "SHARD", className: "ShardDO", sqlite: true, type: "durable_object" }]));
        const second = plan(
            deployJob([{ binding: "SHARD", className: "ShardDO", sqlite: true, type: "durable_object" }], {
                bundle: Buffer.from("export default { v: 2 }").toString("base64"),
            }),
        );

        expect(first.worker?.workerName).toBe("acme");
        expect(second.worker).toMatchObject({ stackName: first.worker?.stackName, workerName: first.worker?.workerName });
    });

    it("creates d1/kv/r2 in the project stack and binds them into the Worker by reference", () => {
        expect.assertions(2);

        const { project, worker } = plan(
            deployJob([
                { binding: "DB", type: "d1" },
                { binding: "CACHE", type: "kv" },
                { binding: "FILES", type: "r2" },
            ]),
        );

        expect(project?.resources).toStrictEqual([
            { id: "d1-acme--db", kind: "d1", name: "acme--db" },
            { id: "kv-acme--cache", kind: "kv", name: "acme--cache" },
            { id: "r2-acme--files", kind: "r2", name: "acme--files" },
        ]);
        expect(worker?.bindings).toStrictEqual([
            { binding: "DB", id: "d1-acme--db", kind: "ref", resource: "d1" },
            { binding: "CACHE", id: "kv-acme--cache", kind: "ref", resource: "kv" },
            { binding: "FILES", id: "r2-acme--files", kind: "ref", resource: "r2" },
        ]);
    });

    it("gives each producer its own queue and consumes it from the control plane only when the app consumes it", () => {
        expect.assertions(2);

        const { project, worker } = plan(
            deployJob([
                { binding: "JOBS", resource: "jobs", type: "queue_producer" },
                { binding: "EVENTS", resource: "events", type: "queue_producer" },
                { binding: "jobs", resource: "jobs", type: "queue_consumer" },
            ]),
        );

        expect(project?.consumers).toStrictEqual([{ id: "queue-acme--jobs-consumer", queueId: "queue-acme--jobs", scriptName: "lunora-cloud-production" }]);
        // The consumer entry itself binds nothing.
        expect(worker?.bindings.map((binding) => binding.binding)).toStrictEqual(["JOBS", "EVENTS"]);
    });

    it("refuses a routed queue when the control-plane script is not configured", () => {
        expect.assertions(1);

        const job = deployJob([
            { binding: "JOBS", resource: "jobs", type: "queue_producer" },
            { binding: "jobs", resource: "jobs", type: "queue_consumer" },
        ]);

        expect(() => planJob(job, { controlPlaneScript: undefined })).toThrow(/LUNORA_CONTROL_PLANE_SCRIPT/u);
    });

    it("binds account capabilities, Durable Objects and the renamed dataset directly on the Worker", () => {
        expect.assertions(2);

        const { project, worker } = plan(
            deployJob([
                { binding: "AI", type: "ai" },
                { binding: "BROWSER", type: "browser" },
                { binding: "IMAGES", type: "images" },
                { binding: "SHARD", className: "ShardDO", sqlite: true, type: "durable_object" },
                { binding: "METRICS", resource: "raw", type: "analytics_engine" },
            ]),
        );

        expect(project?.resources).toStrictEqual([]);
        expect(worker?.bindings).toStrictEqual([
            { binding: "AI", kind: "ai" },
            { binding: "BROWSER", kind: "browser" },
            { binding: "IMAGES", kind: "images" },
            { binding: "SHARD", className: "ShardDO", kind: "durable_object" },
            { binding: "METRICS", dataset: "acme__metrics", kind: "analytics_engine" },
        ]);
    });

    it("applies the platform compatibility defaults, and the manifest's own when given", () => {
        expect.assertions(2);

        expect(plan(deployJob([])).worker?.compatibility).toStrictEqual({ date: DEFAULT_COMPATIBILITY_DATE, flags: ["nodejs_compat"] });

        const job = deployJob([]);

        job.spec.manifest.compatibilityDate = "2025-01-01";
        job.spec.manifest.compatibilityFlags = ["nodejs_als"];

        expect(plan(job).worker?.compatibility).toStrictEqual({ date: "2025-01-01", flags: ["nodejs_als"] });
    });

    it("carries vars as values, secrets by name only, tags, tail consumers and the namespace", () => {
        expect.assertions(1);

        const { worker } = plan(
            deployJob([], { secrets: { API_KEY: "s3cret-value" }, tailConsumers: ["lunora-tail"], vars: { LUNORA_OTLP_ENDPOINT: "https://otlp" } }),
        );

        expect({ ...worker, vars: { ...worker?.vars } }).toMatchObject({
            namespace: "lunora-production",
            secretNames: ["API_KEY"],
            tags: ["org:o1", "project:p1", "env:production"],
            tailConsumers: ["lunora-tail"],
            vars: { LUNORA_OTLP_ENDPOINT: "https://otlp" },
            workerName: "acme",
        });
    });

    it("never puts a secret value into the plan", () => {
        expect.assertions(1);

        expect(JSON.stringify(plan(deployJob([], { secrets: { API_KEY: "s3cret-value" } })))).not.toContain("s3cret-value");
    });

    it("maps the assets config and requires the ASSETS name", () => {
        expect.assertions(3);

        const assets = { config: { not_found_handling: "single-page-application" as const }, files: [{ content: "aGk=", path: "/index.html" }] };

        expect(plan(deployJob([{ binding: "ASSETS", type: "assets" }], { assets })).worker?.assets).toStrictEqual({
            config: { htmlHandling: undefined, notFoundHandling: "single-page-application", runWorkerFirst: undefined },
        });

        refuse(deployJob([{ binding: "STATIC", type: "assets" }], { assets }), /must be named ASSETS/u);
    });

    it("refuses an ASSETS binding with no uploaded files", () => {
        expect.assertions(2);

        refuse(deployJob([{ binding: "ASSETS", type: "assets" }]), /no asset files/u);
    });
});

describe("provision plan: refusals", () => {
    it("refuses workflows, which Alchemy cannot register for a dispatch-namespace script", () => {
        expect.assertions(2);

        refuse(deployJob([{ binding: "FLOW", className: "Flow", type: "workflow" }]), /Workflows cannot be registered/u);
    });

    it.each(["container", "hyperdrive", "pipeline", "vectorize"] as const)("refuses the unsupported %s type", (type) => {
        expect.assertions(2);

        refuse(deployJob([{ binding: "X", type }]), /does not provision/u);
    });

    const contractTypes = Object.keys(BINDING_SUPPORT) as BindingRequirement["type"][];
    // Workflows are `bound` in the contract but Alchemy cannot register them (see plan.mjs).
    const plannable = contractTypes.filter((type) => BINDING_SUPPORT[type] !== "unsupported" && type !== "workflow");
    const refusable = contractTypes.filter((type) => !plannable.includes(type));
    const jobFor = (type: BindingRequirement["type"]) =>
        type === "assets"
            ? deployJob([{ binding: "ASSETS", type }], { assets: { files: [] } })
            : deployJob([{ binding: "B", className: "Klass", resource: "r", type }]);

    it.each(plannable)("plans the contract's %s type", (type) => {
        expect.assertions(1);

        expect(() => plan(jobFor(type))).not.toThrow();
    });

    it.each(refusable)("refuses the contract's %s type", (type) => {
        expect.assertions(1);

        expect(() => plan(jobFor(type))).toThrow(PlanError);
    });

    it.each([
        ["a prototype key", "__proto__x-"],
        ["whitespace", "DB NAME"],
        ["a quote", 'DB"'],
        ["a template-literal payload", ["$", "{process.env.X}"].join("")],
        ["a path", "../etc"],
        ["an empty string", ""],
        ["a leading digit", "1DB"],
        ["a very long name", `A${"b".repeat(64)}`],
    ])("refuses a binding name with %s", (_label, binding) => {
        expect.assertions(2);

        refuse(deployJob([{ binding, type: "ai" }]), /binding name/u);
    });

    it("keeps __proto__ an ordinary own key when it is a valid identifier", () => {
        expect.assertions(2);

        const { worker } = plan(deployJob([], { vars: JSON.parse('{"__proto__":"x"}') as Record<string, string> }));

        expect(Object.getPrototypeOf(worker?.vars)).toBeNull();
        expect(Object.keys(worker?.vars ?? {})).toStrictEqual(["__proto__"]);
    });

    it("refuses a name declared twice across bindings, vars and secrets", () => {
        expect.assertions(4);

        refuse(deployJob([{ binding: "DB", type: "ai" }], { vars: { DB: "x" } }), /more than once/u);
        refuse(deployJob([], { secrets: { K: "v" }, vars: { K: "x" } }), /more than once/u);
    });

    it("refuses a provisioned binding without a control-plane resource name", () => {
        expect.assertions(2);

        const job = deployJob([]);

        job.spec.manifest.bindings = [{ binding: "DB", type: "d1" }];

        refuse(job, /without a resourceName/u);
    });

    it("refuses a hostile or colliding resource name", () => {
        expect.assertions(4);

        const hostile = deployJob([]);

        hostile.spec.manifest.bindings = [{ binding: "DB", resourceName: "Other Tenant/db", type: "d1" }];

        refuse(hostile, /resource name/u);

        const colliding = deployJob([]);

        colliding.spec.manifest.bindings = [
            { binding: "DB", resourceName: "acme-db", type: "d1" },
            { binding: "DB2", resourceName: "acme-db", type: "d1" },
        ];

        refuse(colliding, /same d1 resource/u);
    });

    it("refuses a Durable Object with an invalid class name", () => {
        expect.assertions(2);

        refuse(deployJob([{ binding: "SHARD", className: "Shard DO", type: "durable_object" }]), /class name/u);
    });

    it("refuses control-plane identifiers that are not labels", () => {
        expect.assertions(4);

        refuse(deployJob([], { alias: "Acme Corp" }), /alias/u);
        refuse(deployJob([], { dispatchNamespace: "lunora production" }), /dispatch namespace/u);
    });

    it("refuses a job without a bundle", () => {
        expect.assertions(2);

        refuse(deployJob([], { bundle: "" }), /no bundle/u);
    });

    it("refuses an unknown action", () => {
        expect.assertions(2);

        // Untrusted JSON: the type says deploy | destroy, the wire can say anything.
        refuse(JSON.parse('{"action":"nuke"}') as ProvisionJob, /unknown action/u);
    });
});

describe("provision plan: destroy", () => {
    it("removes the Worker, then the project stack — destroy is only sent for a project that is gone", () => {
        expect.assertions(1);

        expect(plan({ action: "destroy", alias: ALIAS, dispatchNamespace: "lunora-production" })).toStrictEqual({
            stage: "lunora-production",
            steps: [
                { kind: "worker", op: "destroy", stackName: "lunora-worker-acme" },
                { kind: "project", op: "destroy", stackName: "lunora-project-acme" },
            ],
        });
    });
});

describe(assetRelativePath, () => {
    it("maps a URL path to a relative file path", () => {
        expect.assertions(1);

        expect(assetRelativePath("/assets/app.js")).toBe("assets/app.js");
    });

    it.each(["index.html", "/../etc/passwd", "/a/../../b", "/a//b", "/a/./b", String.raw`/a\b`, "/a\0b", "/"])("refuses %j", (path) => {
        expect.assertions(1);

        expect(() => assetRelativePath(path)).toThrow(PlanError);
    });
});
