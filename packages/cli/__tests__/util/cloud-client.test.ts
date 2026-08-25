import { describe, expect, it, vi } from "vitest";

import type { DeployEvent } from "../../src/util/cloud-client";
import { deployToCloud, parseWranglerManifest, rollbackDeployment } from "../../src/util/cloud-client";

/** The slice of `fetch` these tests actually drive — the real signature is wider. */
type FetchStub = (url: string, init: RequestInit) => Promise<Response>;

const ndjsonResponse = (lines: object[]): Response => new Response(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, { status: 200 });

describe(deployToCloud, () => {
    it("pOSTs the bundle + manifest with the deploy key and streams NDJSON events", async () => {
        expect.assertions(4);

        let request: { body: unknown; headers: Headers } | undefined;
        const fetchImpl = vi.fn<FetchStub>(async (_url, init) => {
            request = { body: JSON.parse(init.body as string), headers: new Headers(init.headers) };

            return ndjsonResponse([{ event: "accepted" }, { phase: "provisioning" }, { done: true, status: "live" }]);
        }) as unknown as typeof globalThis.fetch;

        const events: DeployEvent[] = [];
        const result = await deployToCloud(
            {
                apiUrl: "https://cloud/",
                bindings: { durableObjects: [{ binding: "SHARD", className: "ShardDO" }] },
                bundle: "YnVuZGxl",
                cronSpecs: ["0 0 * * *"],
                deployKey: "dk_secret",
                fetch: fetchImpl,
                kind: "preview",
                projectId: "prj_1",
                scriptName: "app",
            },
            (event) => events.push(event),
        );

        expect(result).toStrictEqual({ status: "live" });
        expect(request?.headers.get("authorization")).toBe("Bearer dk_secret");
        expect(request?.body).toMatchObject({
            bindings: { durableObjects: [{ binding: "SHARD", className: "ShardDO" }] },
            bundle: "YnVuZGxl",
            cronSpecs: ["0 0 * * *"],
            kind: "preview",
            projectId: "prj_1",
            scriptName: "app",
        });
        expect(events.map((event) => event["event"] ?? event["phase"] ?? event["status"])).toStrictEqual(["accepted", "provisioning", "live"]);
    });

    it("throws with the server detail on a non-2xx deploy", async () => {
        expect.assertions(1);

        const fetchImpl = vi.fn<FetchStub>(async () => new Response("bad key", { status: 403 })) as unknown as typeof globalThis.fetch;

        await expect(
            deployToCloud({ apiUrl: "https://cloud", bundle: "b", deployKey: "x", fetch: fetchImpl, projectId: "p", scriptName: "s" }, () => {}),
        ).rejects.toThrow(/deploy request failed \(403\): bad key/);
    });
});

describe(rollbackDeployment, () => {
    it("pOSTs the deployment + org and returns the now-serving script", async () => {
        expect.assertions(2);

        let body: unknown;
        const fetchImpl = vi.fn<FetchStub>(async (_url, init) => {
            body = JSON.parse(init.body as string);

            return Response.json({ scriptName: "app-v2", version: 2 }, { status: 200 });
        }) as unknown as typeof globalThis.fetch;

        const result = await rollbackDeployment({ apiUrl: "https://cloud", deployKey: "dk", deploymentId: "dep_1", fetch: fetchImpl, organizationId: "org_1" });

        expect(body).toStrictEqual({ deploymentId: "dep_1", organizationId: "org_1" });
        expect(result).toStrictEqual({ scriptName: "app-v2", version: 2 });
    });

    it("throws on a failed rollback", async () => {
        expect.assertions(1);

        const fetchImpl = vi.fn<FetchStub>(async () => new Response("nope", { status: 409 })) as unknown as typeof globalThis.fetch;

        await expect(
            rollbackDeployment({ apiUrl: "https://cloud", deployKey: "dk", deploymentId: "d", fetch: fetchImpl, organizationId: "o" }),
        ).rejects.toThrow(/rollback failed \(409\)/);
    });
});

describe(parseWranglerManifest, () => {
    it("extracts DO classes, first D1/R2 binding, and crons; drops malformed entries", () => {
        expect.assertions(1);

        const manifest = parseWranglerManifest({
            d1_databases: [{ binding: "DB" }],
            durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }, { name: "NO_CLASS" }] },
            r2_buckets: [{ binding: "FILES" }],
            triggers: { crons: ["0 */6 * * *", 3] },
        });

        expect(manifest).toStrictEqual({
            bindings: { d1: { binding: "DB" }, durableObjects: [{ binding: "SHARD", className: "ShardDO" }], r2: { binding: "FILES" } },
            cronSpecs: ["0 */6 * * *"],
        });
    });

    it("returns an empty manifest for a minimal wrangler", () => {
        expect.assertions(1);

        expect(parseWranglerManifest({})).toStrictEqual({ bindings: {}, cronSpecs: [] });
    });
});
