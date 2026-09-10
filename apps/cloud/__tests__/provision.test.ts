import { describe, expect, it, vi } from "vitest";

import type { CloudflareApi, PutScriptInput } from "../src/cloudflare/api";
import type { TenantDeploymentSpec } from "../src/provision";
import { createCloudflareProvisioner } from "../src/provision";

const spec: TenantDeploymentSpec = {
    alias: "org__project",
    bindings: { d1: { binding: "DB" }, durableObjects: [{ binding: "SHARD", className: "ShardDO" }], r2: { binding: "FILES" } },
    bundle: new TextEncoder().encode("export default {}").buffer,
    cell: "cell-1",
    dispatchNamespace: "lunora-production",
    scriptName: "org__project-v1",
    secrets: { LUNORA_ADMIN_TOKEN: "s3cret" },
    tags: ["org:org", "project:project", "env:production"],
};

const fakeApi = (): { api: CloudflareApi; deletes: string[]; puts: PutScriptInput[]; secrets: string[] } => {
    const puts: PutScriptInput[] = [];
    const secrets: string[] = [];
    const deletes: string[] = [];

    return {
        api: {
            createCustomHostname: vi.fn<CloudflareApi["createCustomHostname"]>(async () => {
                return { id: "ch-1" };
            }),
            createD1Database: vi.fn<CloudflareApi["createD1Database"]>(async () => {
                return { uuid: "d1-uuid-123" };
            }),
            createR2Bucket: vi.fn<CloudflareApi["createR2Bucket"]>(async () => undefined),
            deleteD1Database: vi.fn<CloudflareApi["deleteD1Database"]>(async () => undefined),
            exportD1Database: vi.fn<CloudflareApi["exportD1Database"]>(async () => {
                return { signedUrl: "https://example.invalid/dump.sql" };
            }),
            deleteDispatchScript: vi.fn<CloudflareApi["deleteDispatchScript"]>(async ({ scriptName }) => {
                deletes.push(scriptName);
            }),
            deleteR2Bucket: vi.fn<CloudflareApi["deleteR2Bucket"]>(async () => undefined),
            findD1DatabaseByName: vi.fn<CloudflareApi["findD1DatabaseByName"]>(async () => null),
            putDispatchScript: vi.fn<CloudflareApi["putDispatchScript"]>(async (input) => {
                puts.push(input);
            }),
            putSecret: vi.fn<CloudflareApi["putSecret"]>(async ({ name }) => {
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
        const provisioner = createCloudflareProvisioner({ api, urlForScript: (script) => `https://${script}.lunora.app` });

        const result = await provisioner.deploy(spec);

        // The uploaded script is the versioned id; D1/R2 are named from the stable alias.
        expect(result).toMatchObject({ scriptName: "org__project-v1", url: "https://org__project-v1.lunora.app" });
        expect(result.bundleHash).toMatch(/^[0-9a-f]{64}$/u);
        expect(api.findD1DatabaseByName).toHaveBeenCalledWith("org__project-db");
        expect(api.createD1Database).toHaveBeenCalledWith("org__project-db");
        expect(api.createR2Bucket).toHaveBeenCalledWith("org__project-files");

        const put = puts[0];

        expect(put.bindings).toStrictEqual([
            { id: "d1-uuid-123", name: "DB", type: "d1" },
            { bucket_name: "org__project-files", name: "FILES", type: "r2_bucket" },
            { class_name: "ShardDO", name: "SHARD", type: "durable_object_namespace" },
        ]);
        expect(put.newSqliteClasses).toStrictEqual(["ShardDO"]);
        expect(secrets).toStrictEqual(["LUNORA_ADMIN_TOKEN"]);
    });

    it("destroys by deleting the dispatch script", async () => {
        const { api, deletes } = fakeApi();
        const provisioner = createCloudflareProvisioner({ api, urlForScript: (script) => script });

        await provisioner.destroy({ dispatchNamespace: "lunora-preview", scriptName: "org__project-pr-x" });

        expect(deletes).toStrictEqual(["org__project-pr-x"]);
    });
});
