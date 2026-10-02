import { describe, expect, it } from "vitest";

import type { DeployBackend, DeployHandlerDeps, DeployTarget } from "../src/deploy/handler";
import { handleDeployRequest } from "../src/deploy/handler";
import { CellScheduler } from "../src/deploy/scheduler";
import { TokenBucket } from "../src/deploy/token-bucket";
import type { BindingRequirement, TenantDeploymentSpec } from "../src/provision-contract";
import readJson from "../src/read-json";
import type { TargetDriver } from "../src/targets/driver";
import memoryReleaseStore from "./_helpers/memory-release-store";
import { fakeDriver } from "./support/memory-driver";

/** The converge half of a target driver — what these tests fake. */
type Provisioner = Pick<TargetDriver, "deploy" | "destroy">;

const target: DeployTarget = { organizationId: "org_1", projectId: "proj_1", type: "production" };

// base64("export default {}") — the prebuilt worker module the client uploads.
const BUNDLE = btoa("export default {}");

const okProvisioner: Provisioner = {
    deploy: () => Promise.resolve({ bundleHash: "h1", url: "https://proj.lunora.app" }),
    destroy: () => Promise.resolve(),
};

const request = (key: null | string, body: unknown): Request =>
    new Request("https://cloud/v1/deploy", {
        body: JSON.stringify(body),
        headers: key ? { authorization: `Bearer ${key}`, "content-type": "application/json" } : { "content-type": "application/json" },
        method: "POST",
    });

const deps = (backend: DeployBackend, provisioner: Provisioner): DeployHandlerDeps => {
    return {
        backend,
        driverFor: () => fakeDriver(provisioner),
        releases: memoryReleaseStore().store,
        scheduler: new CellScheduler({ bucket: new TokenBucket({ capacity: 100, refillPerWindow: 100, windowMs: 1000 }) }),
    };
};

const readLines = async (response: Response): Promise<Record<string, unknown>[]> => {
    const text = await response.text();

    return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
};

const backendWith = (overrides: Partial<DeployBackend>): DeployBackend => {
    return {
        createDeployment: () => Promise.resolve({ deploymentId: "dep_1" }),
        placement: () => Promise.resolve({ target: "cloudflare-wfp" }),
        releaseTarget: () => Promise.reject(new Error("no release target in this test")),
        rollbackDeployment: () => Promise.reject(new Error("no rollback in this test")),
        updateStatus: () => Promise.resolve(),
        verifyKey: () => Promise.resolve(target),
        ...overrides,
    };
};

describe(handleDeployRequest, () => {
    it("401 without a bearer deploy key", async () => {
        const response = await handleDeployRequest(
            request(null, { bundle: BUNDLE, projectId: "proj_1", scriptName: "s" }),
            deps(backendWith({}), okProvisioner),
        );

        expect(response.status).toBe(401);
    });

    it("403 for an invalid/revoked key", async () => {
        const response = await handleDeployRequest(
            request("bad", { bundle: BUNDLE, projectId: "proj_1", scriptName: "s" }),
            deps(backendWith({ verifyKey: () => Promise.resolve(null) }), okProvisioner),
        );

        expect(response.status).toBe(403);
    });

    it("400 when projectId/scriptName are missing", async () => {
        const response = await handleDeployRequest(request("k", {}), deps(backendWith({}), okProvisioner));

        expect(response.status).toBe(400);
    });

    it("400 when the bundle is missing — never provisions an empty module", async () => {
        const response = await handleDeployRequest(request("k", { projectId: "proj_1", scriptName: "s" }), deps(backendWith({}), okProvisioner));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("bundle") as string });
    });

    it("400 when the bundle is not valid base64", async () => {
        const response = await handleDeployRequest(
            request("k", { bundle: "!!not-base64!!", projectId: "proj_1", scriptName: "s" }),
            deps(backendWith({}), okProvisioner),
        );

        expect(response.status).toBe(400);
    });

    it("passes the decoded bundle bytes to the provisioner", async () => {
        let uploaded: ArrayBuffer | undefined;
        const capturing: Provisioner = {
            deploy: (spec) => {
                uploaded = spec.bundle;

                return Promise.resolve({ bundleHash: "h1", url: "https://proj.lunora.app" });
            },
            destroy: () => Promise.resolve(),
        };

        const response = await handleDeployRequest(request("k", { bundle: BUNDLE, projectId: "proj_1", scriptName: "s" }), deps(backendWith({}), capturing));

        await response.text();

        expect(uploaded).toBeDefined();
        expect(new TextDecoder().decode(uploaded)).toBe("export default {}");
    });

    it("forwards the request's cronSpecs to createDeployment (feeds the cron fan-out)", async () => {
        let received: string[] | undefined;
        const backend = backendWith({
            createDeployment: (input) => {
                received = input.cronSpecs;

                return Promise.resolve({ deploymentId: "dep_1" });
            },
        });

        const response = await handleDeployRequest(
            request("k", { bundle: BUNDLE, cronSpecs: ["0 */6 * * *", 3 as unknown as string], projectId: "proj_1", scriptName: "s" }),
            deps(backend, okProvisioner),
        );

        await response.text();

        // Only valid string expressions survive.
        expect(received).toStrictEqual(["0 */6 * * *"]);
    });

    it("streams accepted → queued → provisioning → live and records status transitions", async () => {
        const statuses: string[] = [];
        const backend = backendWith({
            createDeployment: () => Promise.resolve({ deploymentId: "dep_42" }),
            updateStatus: ({ status }) => {
                statuses.push(status);

                return Promise.resolve();
            },
        });

        const response = await handleDeployRequest(request("k", { bundle: BUNDLE, projectId: "proj_1", scriptName: "s" }), deps(backend, okProvisioner));

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/x-ndjson");

        const lines = await readLines(response);

        expect(lines[0]).toMatchObject({ deploymentId: "dep_42", event: "accepted" });
        expect(lines.map((line) => line["phase"]).filter(Boolean)).toStrictEqual(["queued", "provisioning", "live"]);
        expect(lines.at(-1)).toMatchObject({ done: true, status: "live" });
        // queued is the create state — status is only patched for provisioning/live/failed.
        expect(statuses).toStrictEqual(["provisioning", "live"]);
    });

    it("streams a failed terminal event when provisioning rejects", async () => {
        const statuses: string[] = [];
        const backend = backendWith({
            updateStatus: ({ status }) => {
                statuses.push(status);

                return Promise.resolve();
            },
        });
        const failing: Provisioner = { deploy: () => Promise.reject(new Error("alchemy not wired")), destroy: () => Promise.resolve() };

        const response = await handleDeployRequest(request("k", { bundle: BUNDLE, projectId: "proj_1", scriptName: "s" }), deps(backend, failing));
        const lines = await readLines(response);

        expect(lines.at(-1)).toMatchObject({ done: true, status: "failed" });
        expect(statuses).toStrictEqual(["provisioning", "failed"]);
    });
});

/**
 * A deploy key's `type` is a privilege CEILING, not a default.
 *
 * It was only ever used to seed `kind` when the caller omitted it, so
 * `body.kind` overrode it freely: a key issued and displayed in the dashboard as
 * `dev` or `preview` could deploy `production`, which activates the project's
 * stable-URL pointer and supersedes the live release. Operators hand out
 * "preview-only" keys on the reasonable assumption that the scope binds
 * somewhere, and it bound nowhere.
 *
 * `target.type` comes from the STORED key row (`deploy_keys.verify` returns
 * `row.type`), not from the caller-supplied key string, so the ceiling cannot be
 * self-asserted by re-encoding a key.
 */
describe("deploy kind is bounded by the key's type", () => {
    const withType = (type: DeployTarget["type"]): DeployBackend => backendWith({ verifyKey: () => Promise.resolve({ ...target, type }) });

    it.each([
        ["preview", "production"],
        ["dev", "production"],
        ["dev", "preview"],
    ])("refuses a %s key deploying %s", async (type, kind) => {
        const response = await handleDeployRequest(
            request("k", { bundle: BUNDLE, kind, projectId: "proj_1", scriptName: "s" }),
            deps(withType(type as DeployTarget["type"]), okProvisioner),
        );

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining(`scoped to ${type}`) as unknown as string });
    });

    it.each([
        ["production", "preview"],
        ["production", "dev"],
        ["preview", "dev"],
        ["preview", "preview"],
    ])("allows a %s key deploying %s", async (type, kind) => {
        const response = await handleDeployRequest(
            request("k", { bundle: BUNDLE, kind, projectId: "proj_1", scriptName: "s" }),
            deps(withType(type as DeployTarget["type"]), okProvisioner),
        );

        expect(response.status).not.toBe(403);
    });

    /**
     * The hole the ceiling check alone did not close: `body.kind` is an arbitrary
     * string, an unknown value ranked below every scope and so passed the ceiling,
     * and it then became the deployment's `kind`. `activate` supersedes only
     * SAME-KIND siblings, so a deployment stamped `"prod"` would never supersede
     * the real `production` release, nor be superseded by it — two live releases,
     * neither aware of the other.
     */
    it("refuses a kind that is not one of the three", async () => {
        const response = await handleDeployRequest(
            request("k", { bundle: BUNDLE, kind: "prod", projectId: "proj_1", scriptName: "s" }),
            deps(backendWith({}), okProvisioner),
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("unknown deploy kind") as unknown as string });
    });

    it("defaults to the key's own type when the caller names no kind", async () => {
        const response = await handleDeployRequest(
            request("k", { bundle: BUNDLE, projectId: "proj_1", scriptName: "s" }),
            deps(withType("preview"), okProvisioner),
        );

        expect(response.status).not.toBe(403);
    });
});

/** A provisioner that records every spec it is handed. */
const capture = (): { provisioner: Provisioner; specs: TenantDeploymentSpec[] } => {
    const specs: TenantDeploymentSpec[] = [];

    return {
        provisioner: {
            deploy: (spec: TenantDeploymentSpec) => {
                specs.push(spec);

                return Promise.resolve({ bundleHash: "h1", url: "https://proj.lunora.app" });
            },
            destroy: () => Promise.resolve(),
        },
        specs,
    };
};

const SHARD: BindingRequirement = { binding: "SHARD", className: "ShardDO", sqlite: true, type: "durable_object" };

const deployWith = async (extra: Record<string, unknown>): Promise<{ created: number; response: Response; specs: TenantDeploymentSpec[] }> => {
    const { provisioner, specs } = capture();
    let created = 0;
    const backend = backendWith({
        createDeployment: () => {
            created += 1;

            return Promise.resolve({ deploymentId: "dep_1" });
        },
    });
    const response = await handleDeployRequest(request("k", { bundle: BUNDLE, projectId: "proj_1", scriptName: "s", ...extra }), deps(backend, provisioner));

    if (response.status === 200) {
        await response.text();
    }

    return { created, response, specs };
};

/** The 400 error for a refused deploy, asserting no deployment row was recorded and nothing was provisioned. */
const refusal = async (extra: Record<string, unknown>): Promise<string> => {
    const { created, response, specs } = await deployWith(extra);
    const { error } = await readJson<{ error: string }>(response);

    expect(response.status).toBe(400);
    expect(created).toBe(0);
    expect(specs).toHaveLength(0);

    return error;
};

const manifest = (bindings: unknown[], rest: Record<string, unknown> = {}): { manifest: Record<string, unknown> } => {
    return { manifest: { bindings, ...rest } };
};

const b64 = (text: string): string => btoa(text);

const ASSETS_BINDING = { binding: "ASSETS", type: "assets" };

describe("deploy manifest validation", () => {
    it("floors the manifest to ShardDO when the request omits one", async () => {
        const { specs } = await deployWith({});

        expect(specs[0]?.manifest).toStrictEqual({ bindings: [SHARD] });
        expect(specs[0]?.assets).toBeUndefined();
    });

    it("does not duplicate ShardDO when the manifest already binds it", async () => {
        const { specs } = await deployWith(manifest([{ binding: "SHARD", className: "ShardDO", sqlite: true, type: "durable_object" }]));

        expect(specs[0]?.manifest.bindings).toStrictEqual([SHARD]);
    });

    it("builds the spec from a manifest carrying every supported type", async () => {
        const bindings = [
            { binding: "AI", type: "ai" },
            { binding: "EVENTS", resource: "events", type: "analytics_engine" },
            { binding: "ASSETS", type: "assets" },
            { binding: "BROWSER", type: "browser" },
            { binding: "DB", resource: "app-db", resourceId: "someone-elses-id", type: "d1" },
            { binding: "SHARD", className: "ShardDO", sqlite: true, type: "durable_object" },
            { binding: "SCHEDULER", className: "SchedulerDO", sqlite: true, type: "durable_object" },
            { binding: "IMAGES", type: "images" },
            { binding: "CACHE", type: "kv" },
            { binding: "JOBS_IN", resource: "jobs", type: "queue_consumer" },
            { binding: "JOBS", resource: "jobs", type: "queue_producer" },
            { binding: "FILES", resource: "files", type: "r2" },
        ];
        const assets = {
            config: { html_handling: "auto-trailing-slash", not_found_handling: "single-page-application", run_worker_first: ["/api/*"] },
            files: [
                { content: b64("<h1>hi</h1>"), path: "/index.html" },
                { content: b64("body{}"), path: "/assets/app.css" },
            ],
        };

        const { response, specs } = await deployWith({
            assets,
            ...manifest(bindings, { compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"] }),
        });

        expect(response.status).toBe(200);
        expect(specs).toHaveLength(1);
        expect(specs[0]).toMatchObject({
            alias: "s",
            assets,
            kind: "production",
            manifest: {
                // `resourceId` is never carried: a tenant-supplied account id means nothing in the platform account.
                bindings: bindings.map(({ resourceId: _resourceId, ...rest }) => rest),
                compatibilityDate: "2026-09-01",
                compatibilityFlags: ["nodejs_compat"],
            },
            tags: ["org:org_1", "project:proj_1", "env:production"],
        });
        expect(specs[0]).not.toHaveProperty("bindings");
        // Target-neutral: where the tenant lands is the driver's configuration, not the spec's.
        expect(specs[0]).not.toHaveProperty("cell");
        expect(specs[0]).not.toHaveProperty("dispatchNamespace");
    });

    it("refuses every unsupported binding with its reason, before recording a deployment", async () => {
        const error = await refusal(
            manifest([
                { binding: "SANDBOX", className: "Sandbox", type: "container" },
                { binding: "PG", type: "hyperdrive" },
                { binding: "STREAM", type: "pipeline" },
                { binding: "INDEX", type: "vectorize" },
                { binding: "FLOW", className: "OrderFlow", type: "workflow" },
            ]),
        );

        expect(error).toContain("container (SANDBOX): containers need an image built and pushed per deploy");
        expect(error).toContain("hyperdrive (PG): Hyperdrive points at your own database");
        expect(error).toContain("pipeline (STREAM): a pipeline needs its stream and sink configured");
        expect(error).toContain("vectorize (INDEX): an index needs its dimensions and metric");
        expect(error).toContain("workflow (FLOW): Workflows register per account script");
    });

    it("refuses an assets binding not named ASSETS", async () => {
        await expect(
            refusal({ assets: { files: [{ content: b64("x"), path: "/x" }] }, ...manifest([{ binding: "STATIC", type: "assets" }]) }),
        ).resolves.toContain("must be named ASSETS");
    });

    it("refuses an unknown binding type", async () => {
        await expect(refusal(manifest([{ binding: "X", type: "telepathy" }]))).resolves.toContain('binding X has unknown type "telepathy"');
    });

    it.each([["1BAD"], ["has-dash"], ["a b"], [""], ["A".repeat(65)]])("refuses the binding name %j", async (name) => {
        await expect(refusal(manifest([{ binding: name, type: "kv" }]))).resolves.toContain("binding name");
    });

    it.each([
        [{ type: "kv" }, "must be an object with string `binding` and `type`"],
        ["nope", "must be an object with string `binding` and `type`"],
        [{ binding: "DO", type: "durable_object" }, "needs a className"],
        [{ binding: "FLOW", type: "workflow" }, "needs a className"],
        [{ binding: "DO", className: "not-a-class", type: "durable_object" }, "className must be an identifier"],
        [{ binding: "FILES", resource: "../x", type: "r2" }, "resource must match"],
        [{ binding: "DO", className: "X", sqlite: "yes", type: "durable_object" }, "sqlite must be a boolean"],
    ])("refuses the malformed binding %j", async (entry, message) => {
        await expect(refusal(manifest([entry]))).resolves.toContain(message);
    });

    it("refuses a manifest without a bindings array", async () => {
        await expect(refusal({ manifest: { bindings: "all" } })).resolves.toContain("`bindings` array");
    });

    it("refuses a duplicate binding name, including one that shadows the ShardDO floor", async () => {
        await expect(
            refusal(
                manifest([
                    { binding: "CACHE", type: "kv" },
                    { binding: "CACHE", type: "r2" },
                ]),
            ),
        ).resolves.toContain("CACHE is declared more than once");
        await expect(refusal(manifest([{ binding: "SHARD", type: "kv" }]))).resolves.toContain("SHARD is declared more than once");
    });

    it("refuses binding names that differ only in case, since resource names fold case", async () => {
        await expect(
            refusal(
                manifest([
                    { binding: "DB", type: "d1" },
                    { binding: "db", type: "kv" },
                ]),
            ),
        ).resolves.toContain("db is declared more than once");
    });

    it("refuses a script name that could collide as a project alias", async () => {
        await expect(refusal({ scriptName: "app--b" })).resolves.toContain("scriptName must be");
        await expect(refusal({ scriptName: "My_App" })).resolves.toContain("scriptName must be");
    });

    it("refuses a provisioned resource whose name would exceed Cloudflare's limit", async () => {
        await expect(refusal({ scriptName: "a".repeat(55), ...manifest([{ binding: "UPLOADS", type: "r2" }]) })).resolves.toContain("exceeds 63");
    });

    it("caps the binding and durable object counts", async () => {
        await expect(
            refusal(
                manifest(
                    Array.from({ length: 65 }, (_, index) => {
                        return { binding: `KV_${String(index)}`, type: "kv" };
                    }),
                ),
            ),
        ).resolves.toContain("the limit is 64");
        await expect(
            refusal(
                manifest(
                    Array.from({ length: 25 }, (_, index) => {
                        return { binding: `DO_${String(index)}`, className: `Do${String(index)}`, type: "durable_object" };
                    }),
                ),
            ),
        ).resolves.toContain("more than 25 durable_object bindings");
    });

    it.each([["2026-9-1"], ["yesterday"], [20_260_901]])("refuses the compatibilityDate %j", async (compatibilityDate) => {
        await expect(refusal(manifest([], { compatibilityDate }))).resolves.toContain("compatibilityDate must be YYYY-MM-DD");
    });

    it.each([[["Nodejs_Compat"]], ["nodejs_compat"], [[1]], [Array.from({ length: 33 }).fill("nodejs_compat")]])(
        "refuses the compatibilityFlags %j",
        async (compatibilityFlags) => {
            await expect(refusal(manifest([], { compatibilityFlags }))).resolves.toContain("compatibilityFlags must be at most 32");
        },
    );
});

describe("deploy assets validation", () => {
    const withAssets = (assets: unknown): Record<string, unknown> => {
        return { assets, ...manifest([ASSETS_BINDING]) };
    };

    it("refuses assets sent without an assets binding", async () => {
        await expect(refusal({ assets: { files: [{ content: b64("x"), path: "/x" }] } })).resolves.toContain("no assets binding");
    });

    it("refuses an assets binding without assets", async () => {
        await expect(refusal(manifest([ASSETS_BINDING]))).resolves.toContain("carries no assets");
        await expect(refusal(withAssets({ files: [] }))).resolves.toContain("non-empty array");
    });

    it("refuses a second assets binding", async () => {
        await expect(
            refusal({ assets: { files: [{ content: b64("x"), path: "/x" }] }, ...manifest([ASSETS_BINDING, { binding: "STATIC", type: "assets" }]) }),
        ).resolves.toContain("more than one assets binding");
    });

    it.each([["index.html"], ["/../etc/passwd"], ["/a/../../b"], ["/a\u0000b"]])("refuses the asset path %j", async (path) => {
        await expect(refusal(withAssets({ files: [{ content: b64("x"), path }] }))).resolves.toContain("must start with / and contain no .. segment or NUL");
    });

    it("refuses a duplicate asset path and non-base64 content", async () => {
        await expect(
            refusal(
                withAssets({
                    files: [
                        { content: b64("a"), path: "/a" },
                        { content: b64("b"), path: "/a" },
                    ],
                }),
            ),
        ).resolves.toContain("appears more than once");
        await expect(refusal(withAssets({ files: [{ content: "not base64!", path: "/a" }] }))).resolves.toContain("not valid base64");
    });

    it("caps a single file, the total size and the file count", async () => {
        // Base64 of zero bytes is all "A"; four characters per three bytes.
        const zeros = (mebibytes: number): string => "A".repeat(Math.ceil((mebibytes * 1024 * 1024) / 3) * 4);
        const big = zeros(26);

        await expect(refusal(withAssets({ files: [{ content: big, path: "/big" }] }))).resolves.toContain("per-file limit");

        const twenty = zeros(20);

        await expect(
            refusal(
                withAssets({
                    files: ["/a", "/b", "/c"].map((path) => {
                        return { content: twenty, path };
                    }),
                }),
            ),
        ).resolves.toContain("total limit");
        await expect(
            refusal(
                withAssets({
                    files: Array.from({ length: 20_001 }, (_, index) => {
                        return { content: "", path: `/f${String(index)}` };
                    }),
                }),
            ),
        ).resolves.toContain("the limit is 20000");
    });

    it.each([
        [{ serve_directly: true }, "assets.config.serve_directly is not supported"],
        [{ html_handling: "sometimes" }, "html_handling must be one of"],
        [{ not_found_handling: "teapot" }, "not_found_handling must be one of"],
        [{ run_worker_first: "yes" }, "run_worker_first must be a boolean"],
        [{ run_worker_first: [1] }, "run_worker_first must be a boolean"],
    ])("refuses the assets config %j", async (config, message) => {
        await expect(refusal(withAssets({ config, files: [{ content: b64("x"), path: "/x" }] }))).resolves.toContain(message);
    });
});

describe("deploy body size", () => {
    it("413s a declared oversized body without reading it", async () => {
        const response = await handleDeployRequest(
            new Request("https://cloud/v1/deploy", {
                body: "{}",
                headers: { authorization: "Bearer k", "content-length": String(101 * 1024 * 1024) },
                method: "POST",
            }),
            deps(backendWith({}), okProvisioner),
        );

        expect(response.status).toBe(413);
    });

    it("400s a JSON body that is not an object", async () => {
        const response = await handleDeployRequest(request("k", ["not", "an", "object"]), deps(backendWith({}), okProvisioner));

        expect(response.status).toBe(400);
    });
});
