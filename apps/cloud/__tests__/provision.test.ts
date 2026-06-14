import { describe, expect, it, vi } from "vitest";

import type { CloudflareApi, PutScriptInput } from "../src/cloudflare/api";
import type { TenantDeploymentSpec } from "../src/provision";
import { createCloudflareProvisioner } from "../src/provision";

const spec: TenantDeploymentSpec = {
    bindings: { d1: { binding: "DB" }, durableObjects: [{ binding: "SHARD", className: "ShardDO" }], r2: { binding: "FILES" } },
    bundle: new TextEncoder().encode("export default {}").buffer as ArrayBuffer,
    cell: "cell-1",
    dispatchNamespace: "cirrus-production",
    scriptName: "org__project",
    secrets: { CIRRUS_ADMIN_TOKEN: "s3cret" },
    tags: ["org:org", "project:project", "env:production"],
};

const fakeApi = (): { api: CloudflareApi; deletes: string[]; puts: PutScriptInput[]; secrets: string[] } => {
    const puts: PutScriptInput[] = [];
    const secrets: string[] = [];
    const deletes: string[] = [];

    return {
        api: {
            createCustomHostname: vi.fn(async () => {
                return { id: "ch-1" };
            }),
            createD1Database: vi.fn(async () => {
                return { uuid: "d1-uuid-123" };
            }),
            createR2Bucket: vi.fn(async () => undefined),
            deleteDispatchScript: vi.fn(async ({ scriptName }) => {
                deletes.push(scriptName);
            }),
            putDispatchScript: vi.fn(async (input) => {
                puts.push(input);
            }),
            putSecret: vi.fn(async ({ name }) => {
                secrets.push(name);
            }),
        },
        deletes,
        puts,
        secrets,
    };
};

describe(createCloudflareProvisioner, () => {
    it("provisions D1 + R2, uploads the script with bindings + DO migration, applies secrets", async () => {
        const { api, puts, secrets } = fakeApi();
        const provisioner = createCloudflareProvisioner({ api, urlForScript: (script) => `https://${script}.cirrus.app` });

        const result = await provisioner.deploy(spec);

        expect(result).toMatchObject({ scriptName: "org__project", url: "https://org__project.cirrus.app" });
        expect(result.bundleHash).toMatch(/^[0-9a-f]{64}$/u);
        expect(api.createD1Database).toHaveBeenCalledWith("org__project-db");
        expect(api.createR2Bucket).toHaveBeenCalledWith("org__project-files");

        const put = puts[0];

        expect(put.bindings).toStrictEqual([
            { id: "d1-uuid-123", name: "DB", type: "d1" },
            { bucket_name: "org__project-files", name: "FILES", type: "r2_bucket" },
            { class_name: "ShardDO", name: "SHARD", type: "durable_object_namespace" },
        ]);
        expect(put.newSqliteClasses).toStrictEqual(["ShardDO"]);
        expect(secrets).toStrictEqual(["CIRRUS_ADMIN_TOKEN"]);
    });

    it("destroys by deleting the dispatch script", async () => {
        const { api, deletes } = fakeApi();
        const provisioner = createCloudflareProvisioner({ api, urlForScript: (script) => script });

        await provisioner.destroy({ dispatchNamespace: "cirrus-preview", scriptName: "org__project-pr-x" });

        expect(deletes).toStrictEqual(["org__project-pr-x"]);
    });
});
