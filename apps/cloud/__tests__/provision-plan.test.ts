import { MAX_RELEASE_ALIAS_LENGTH, RELEASE_ALIAS_PATTERN } from "@lunora/config/celld";
import { describe, expect, it } from "vitest";

import type { ProvisionJob } from "../containers/provision/plan.mjs";
import { ALIAS_PATTERN, assetRelativePath, DEFAULT_COMPATIBILITY_DATE, MAX_ALIAS_LENGTH, PlanError, planJob } from "../containers/provision/plan.mjs";
import type { BindingRequirement } from "../src/provision-contract";
import { BINDING_SUPPORT as BINDING_SUPPORT_BY_TARGET, tenantResourceName } from "../src/provision-contract";

/**
 * The provision box's job → plan mapping. The plan is the only thing the
 * static Alchemy program reads, so every tenant-controlled value is checked
 * here, and resource names are the control plane's (`tenantResourceName`),
 * carried on each binding as `resourceName`.
 */

const ALIAS = "acme";
const ACCOUNT = "a".repeat(32);
const STATE = { token: "state-token", url: "https://alchemy-state-store.cell.workers.dev" };

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
            manifest: { bindings: bindings.map((requirement) => withName(requirement)) },
            secrets: {},
            tags: ["org:o1", "project:p1", "env:production"],
            target: { cell: "cell-1", dispatchNamespace: "lunora-production", kind: "dispatch-namespace" },
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
        refuse(deployJob([], { target: { cell: "cell-1", dispatchNamespace: "lunora production", kind: "dispatch-namespace" } }), /dispatch namespace/u);
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

        expect(
            plan({ action: "destroy", alias: ALIAS, target: { cell: "cell-1", dispatchNamespace: "lunora-production", kind: "dispatch-namespace" } }),
        ).toStrictEqual({
            stage: "lunora-production",
            state: "cell",
            steps: [
                { kind: "worker", op: "destroy", stackName: "lunora-worker-acme" },
                { kind: "project", op: "destroy", stackName: "lunora-project-acme" },
            ],
            target: { kind: "dispatch-namespace", namespace: "lunora-production" },
        });
    });

    it("destroys an account target's stacks on the account's stage, with the platform's state", () => {
        expect.assertions(1);

        expect(plan({ action: "destroy", alias: ALIAS, target: { accountId: ACCOUNT, apiToken: "tok", kind: "account", state: STATE } })).toMatchObject({
            stage: `account-${ACCOUNT}`,
            state: "platform",
            target: { accountId: ACCOUNT, kind: "account" },
        });
    });
});

describe("provision plan: a customer's own account (cloudflare-workers)", () => {
    const accountJob = (bindings: BindingRequirement[], overrides: Partial<DeployJob["spec"]> = {}): DeployJob =>
        deployJob(bindings, { target: { accountId: ACCOUNT, apiToken: "tok", kind: "account", state: STATE }, ...overrides });

    it("plans a plain Worker on the account's stage: no namespace, its own crons, the platform's state", () => {
        expect.assertions(4);

        const result = plan(accountJob([], { crons: ["*/5 * * * *", "0 3 * * 1"] }));

        expect(result.stage).toBe(`account-${ACCOUNT}`);
        expect(result.state).toBe("platform");
        expect(result.worker).not.toHaveProperty("namespace");
        expect(result.worker?.crons).toStrictEqual(["*/5 * * * *", "0 3 * * 1"]);
    });

    it("never writes the token or the state store's bearer into the plan", () => {
        expect.assertions(2);

        const written = JSON.stringify(plan(accountJob([], { secrets: {} })));

        expect(written).not.toContain('"tok"');
        expect(written).not.toContain("state-token");
    });

    it("refuses an account job that names no platform state store, rather than keep its state in the customer's account", () => {
        expect.assertions(4);

        refuse(accountJob([], { target: { accountId: ACCOUNT, apiToken: "tok", kind: "account" } as never }), /platform state store/u);
        refuse(
            accountJob([], { target: { accountId: ACCOUNT, apiToken: "tok", kind: "account", state: { token: "t", url: "https://evil.example.com" } } }),
            /platform state store/u,
        );
    });

    it("attaches a consumed queue to the Worker itself, never to the control plane", () => {
        expect.assertions(2);

        const { project, worker } = plan(
            accountJob([
                { binding: "JOBS", resource: "jobs", type: "queue_producer" },
                { binding: "jobs", resource: "jobs", type: "queue_consumer" },
            ]),
        );

        expect(project?.consumers).toStrictEqual([]);
        expect(worker?.consumers).toStrictEqual([{ id: "queue-acme--jobs-consumer", queueId: "queue-acme--jobs" }]);
    });

    it("refuses a malformed account id, a missing token, and a hostile cron", () => {
        expect.assertions(6);

        refuse(accountJob([], { target: { accountId: "acme", apiToken: "tok", kind: "account", state: STATE } }), /account id/u);
        refuse(accountJob([], { target: { accountId: ACCOUNT, apiToken: "", kind: "account", state: STATE } }), /no token/u);
        refuse(accountJob([], { crons: ["* * * * *; rm -rf /"] }), /cron expression/u);
    });

    it("refuses crons for a dispatch-namespace Worker, which cannot carry them", () => {
        expect.assertions(2);

        refuse(deployJob([], { crons: ["* * * * *"] }), /cannot carry cron triggers/u);
    });
});

describe("the provision plan's alias rule", () => {
    // plan.mjs ships as plain JS in the provision container and cannot import
    // `@lunora/config`, so it carries a copy of the alias rule; this keeps the copy exact.
    it("is the one `@lunora/config/celld` defines", () => {
        expect(ALIAS_PATTERN.source).toBe(RELEASE_ALIAS_PATTERN.source);
        expect(ALIAS_PATTERN.flags).toBe(RELEASE_ALIAS_PATTERN.flags);
        expect(MAX_ALIAS_LENGTH).toBe(MAX_RELEASE_ALIAS_LENGTH);
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
