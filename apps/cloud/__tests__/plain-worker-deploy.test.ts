import { describe, expect, it } from "vitest";

import { handleDeployRequest } from "../src/deploy/handler";
import { parsePayload } from "../src/deploy/manifest-parse";
import { createDeployPacer } from "../src/deploy/pacing";
import type { ReleaseTarget } from "../src/deploy/release";
import { rollbackRelease } from "../src/deploy/release";
import type { DeployBackend, DeployHandlerDeps } from "../src/deploy/release-core";
import { WORKER_RUNTIME_TAG } from "../src/project-runtime";
import type { TenantDeploymentSpec } from "../src/provision-contract";
import type { TargetDriver } from "../src/targets/driver";
import memoryReleaseStore from "./_helpers/memory-release-store";
import { fakeDriver } from "./support/memory-driver";

/**
 * The deploy core for a plain Cloudflare Worker (`runtime: "worker"`): no
 * `ShardDO` floor (its bundle exports no such class, and a binding to a class
 * the bundle lacks fails the upload), its wrangler `vars` bound as plain text —
 * kept through the stored release, so a rollback keeps them — and the
 * `runtime:worker` script tag the log tail reads, on the deploy and on a rollback.
 */

const BUNDLE = btoa("export default {}");
const DO_COUNTER = { binding: "COUNTER", className: "Counter", sqlite: true, type: "durable_object" as const };

type Provisioner = Pick<TargetDriver, "deploy" | "destroy">;

const capture = (): { provisioner: Provisioner; specs: TenantDeploymentSpec[] } => {
    const specs: TenantDeploymentSpec[] = [];

    return {
        provisioner: {
            deploy: (spec) => {
                specs.push(spec);

                return Promise.resolve({ url: `https://${spec.alias}.lunora.app` });
            },
            destroy: () => Promise.resolve(),
        },
        specs,
    };
};

const backendWith = (overrides: Partial<DeployBackend> = {}): DeployBackend => {
    return {
        createDeployment: () => Promise.resolve({ deploymentId: "dep_new", version: 1 }),
        placement: () => Promise.resolve({ target: "cloudflare-wfp" }),
        releaseTarget: () => Promise.reject(new Error("no release target in this test")),
        rollbackDeployment: () => Promise.resolve({ scriptName: "app", version: 1 }),
        updateStatus: () => Promise.resolve(),
        verifyKey: () => Promise.resolve({ organizationId: "org_1", projectId: "proj_1", type: "production" as const }),
        ...overrides,
    };
};

const deps = (backend: DeployBackend, provisioner: Provisioner, overrides: Partial<DeployHandlerDeps> = {}): DeployHandlerDeps => {
    return { backend, driverFor: () => fakeDriver(provisioner), pacer: createDeployPacer(), releases: memoryReleaseStore().store, ...overrides };
};

const deploy = async (body: Record<string, unknown>, handlerDeps: DeployHandlerDeps): Promise<{ status: number; text: string }> => {
    const response = await handleDeployRequest(
        new Request("https://cloud/v1/deploy", {
            body: JSON.stringify({ bundle: BUNDLE, projectId: "proj_1", scriptName: "app", ...body }),
            headers: { authorization: "Bearer k", "content-type": "application/json" },
            method: "POST",
        }),
        handlerDeps,
    );

    return { status: response.status, text: await response.text() };
};

describe("manifest validation by runtime", () => {
    it("floors ShardDO for a Lunora app and not for a plain Worker", () => {
        expect.assertions(3);

        const manifest = { bindings: [DO_COUNTER] };
        const lunora = parsePayload({ manifest }, "app", "cloudflare-wfp", "lunora");
        const worker = parsePayload({ manifest }, "app", "cloudflare-wfp", "worker");

        expect(lunora).toMatchObject({ value: { manifest: { bindings: [{ binding: "SHARD", className: "ShardDO" }, DO_COUNTER] } } });
        expect(worker).toStrictEqual({ value: { assets: undefined, manifest: { bindings: [DO_COUNTER] } } });
        // A caller that does not say is a Lunora app, as every caller was before the setting.
        expect(parsePayload({ manifest }, "app", "cloudflare-wfp")).toStrictEqual(lunora);
    });

    it("carries vars as plain text, in the manifest the release store keeps", () => {
        expect.assertions(1);

        expect(parsePayload({ manifest: { bindings: [], vars: { GREETING: "hi", MODE: "" } } }, "app", "cloudflare-wfp", "worker")).toStrictEqual({
            value: { assets: undefined, manifest: { bindings: [], vars: { GREETING: "hi", MODE: "" } } },
        });
    });

    it.each([
        ["a non-string value", { LIMIT: 3 }, "var LIMIT must be a string; Lunora Cloud binds vars as plain text"],
        ["the platform's own namespace", { LUNORA_ADMIN_TOKEN: "x" }, "var LUNORA_ADMIN_TOKEN is in the LUNORA_ namespace Lunora Cloud sets itself; rename it"],
        ["a binding's name", { counter: "x" }, "var counter has the name of a binding; a Worker's env holds one value per name"],
        ["a name that is no env key", { "my-var": "x" }, String.raw`var name "my-var" must match ^[A-Za-z_]\w{0,63}$ (it becomes an env key)`],
        ["a value over Cloudflare's limit", { BIG: "x".repeat(5121) }, "var BIG exceeds Cloudflare's 5120-byte limit for one variable"],
        ["an array", ["x"], "manifest.vars must be an object of name → string"],
    ])("refuses %s, by name", (_label, vars, error) => {
        expect.assertions(1);

        expect(parsePayload({ manifest: { bindings: [DO_COUNTER], vars } }, "app", "cloudflare-wfp", "worker")).toStrictEqual({ error });
    });

    it("refuses a queue consumed but never produced, which would deploy and never receive a message", () => {
        expect.assertions(3);

        const consumerOnly = { bindings: [{ binding: "jobs", resource: "jobs", type: "queue_consumer" }] };
        const both = { bindings: [...consumerOnly.bindings, { binding: "JOB_QUEUE", resource: "jobs", type: "queue_producer" }] };

        expect(parsePayload({ manifest: consumerOnly }, "app", "cloudflare-wfp", "worker")).toMatchObject({
            error: expect.stringMatching(/^this Worker consumes jobs but binds no producer for it/u) as string,
        });
        expect(parsePayload({ manifest: consumerOnly }, "app", "cloudflare-workers", "worker")).toHaveProperty("error");
        expect(parsePayload({ manifest: both }, "app", "cloudflare-wfp", "worker")).toHaveProperty("value");
    });

    it("says why an assets binding must be ASSETS", () => {
        expect.assertions(1);

        const parsed = parsePayload(
            { assets: { files: [{ content: btoa("x"), path: "/a" }] }, manifest: { bindings: [{ binding: "STATIC", type: "assets" }] } },
            "app",
            "cloudflare-wfp",
            "worker",
        );

        expect(parsed).toStrictEqual({
            error: "the assets binding must be named ASSETS on Lunora Cloud, not STATIC: the platform binds uploaded static assets under that one name, so rename it in the wrangler config and in the Worker",
        });
    });
});

describe("pOST /v1/deploy with runtime worker", () => {
    it("records the runtime, binds the vars, adds no ShardDO and tags the script for the log tail", async () => {
        expect.assertions(5);

        const created: Parameters<DeployBackend["createDeployment"]>[0][] = [];
        const { provisioner, specs } = capture();
        const backend = backendWith({
            createDeployment: (input) => {
                created.push(input);

                return Promise.resolve({ deploymentId: "dep_new", version: 1 });
            },
        });
        const telemetry = { endpoint: "https://otlp", token: "tok" };
        const { status } = await deploy(
            { manifest: { bindings: [DO_COUNTER], vars: { GREETING: "hi" } }, runtime: "worker" },
            deps(backend, provisioner, { resolveTelemetry: () => Promise.resolve(telemetry) }),
        );
        const [spec] = specs;

        expect(status).toBe(200);
        expect(created[0]?.runtime).toBe("worker");
        expect(spec?.manifest).toStrictEqual({ bindings: [DO_COUNTER] });
        // The tenant's vars and the platform's, which win and are never the tenant's to set.
        expect(spec?.vars).toStrictEqual({ GREETING: "hi", LUNORA_OTLP_ENDPOINT: "https://otlp" });
        expect(spec?.tags).toStrictEqual(["org:org_1", "project:proj_1", "env:production", WORKER_RUNTIME_TAG]);
    });

    it("deploys a body that names no runtime as a Lunora app, as before", async () => {
        expect.assertions(3);

        const created: Parameters<DeployBackend["createDeployment"]>[0][] = [];
        const { provisioner, specs } = capture();

        await deploy(
            { manifest: { bindings: [] } },
            deps(
                backendWith({
                    createDeployment: (input) => {
                        created.push(input);

                        return Promise.resolve({ deploymentId: "dep_new" });
                    },
                }),
                provisioner,
            ),
        );

        expect(created[0]?.runtime).toBe("lunora");
        expect(specs[0]?.manifest.bindings.map((binding) => binding.binding)).toStrictEqual(["SHARD"]);
        expect(specs[0]?.tags).not.toContain(WORKER_RUNTIME_TAG);
    });

    it("400s a runtime it does not know, before recording anything", async () => {
        expect.assertions(2);

        let recorded = false;
        const { provisioner } = capture();
        const response = await deploy(
            { manifest: { bindings: [] }, runtime: "deno" },
            deps(
                backendWith({
                    createDeployment: () => {
                        recorded = true;

                        return Promise.resolve({ deploymentId: "dep_new" });
                    },
                }),
                provisioner,
            ),
        );

        expect(response).toStrictEqual({ status: 400, text: JSON.stringify({ error: 'unknown runtime "deno" — expected lunora or worker' }) });
        expect(recorded).toBe(false);
    });

    it("fails a release whose var is also a secret of the project, rather than pick one", async () => {
        expect.assertions(2);

        const { provisioner, specs } = capture();
        const { text } = await deploy(
            { manifest: { bindings: [], vars: { API_URL: "https://a" } }, runtime: "worker" },
            deps(backendWith({ resolveSecrets: () => Promise.resolve({ API_URL: "secret" }) }), provisioner),
        );

        expect(text).toContain("API_URL is both a wrangler var and a secret of this project; remove one");
        expect(specs).toStrictEqual([]);
    });
});

describe("rolling a plain Worker back", () => {
    it("re-converges the stored release with its vars and its runtime tag", async () => {
        expect.assertions(2);

        const { provisioner, specs } = capture();
        const { store } = memoryReleaseStore();

        await store.put("dep_prev", { bundle: BUNDLE, manifest: { bindings: [DO_COUNTER], vars: { GREETING: "old" } } });

        const target: ReleaseTarget = {
            adminToken: "admin-prev",
            alias: "app",
            kind: "production",
            organizationId: "org_1",
            projectId: "proj_1",
            runtime: "worker",
            target: "cloudflare-wfp",
        };

        await rollbackRelease(
            { deploymentId: "dep_prev", key: "k", organizationId: "org_1" },
            deps(backendWith({ releaseTarget: () => Promise.resolve(target) }), provisioner, { releases: store }),
        );

        expect(specs[0]?.vars).toStrictEqual({ GREETING: "old" });
        expect(specs[0]?.tags).toContain(WORKER_RUNTIME_TAG);
    });
});
