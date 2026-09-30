import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeployEvent } from "../../src/util/cloud-client";
import { collectAssets, deployToCloud, resolveDeployConfigPath, rollbackDeployment } from "../../src/util/cloud-client";

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
                assets: { files: [{ content: "aGk=", path: "/index.html" }] },
                bundle: "YnVuZGxl",
                cronSpecs: ["0 0 * * *"],
                deployKey: "dk_secret",
                fetch: fetchImpl,
                kind: "preview",
                manifest: { bindings: [{ binding: "SHARD", className: "ShardDO", type: "durable_object" }], compatibilityDate: "2026-01-01" },
                projectId: "prj_1",
                scriptName: "app",
            },
            (event) => events.push(event),
        );

        expect(result).toStrictEqual({ status: "live" });
        expect(request?.headers.get("authorization")).toBe("Bearer dk_secret");
        expect(request?.body).toStrictEqual({
            assets: { files: [{ content: "aGk=", path: "/index.html" }] },
            bundle: "YnVuZGxl",
            cronSpecs: ["0 0 * * *"],
            kind: "preview",
            manifest: { bindings: [{ binding: "SHARD", className: "ShardDO", type: "durable_object" }], compatibilityDate: "2026-01-01" },
            projectId: "prj_1",
            scriptName: "app",
        });
        expect(events.map((event) => event["event"] ?? event["phase"] ?? event["status"])).toStrictEqual(["accepted", "provisioning", "live"]);
    });

    it("throws with the server detail on a non-2xx deploy", async () => {
        expect.assertions(1);

        const fetchImpl = vi.fn<FetchStub>(async () => new Response("bad key", { status: 403 })) as unknown as typeof globalThis.fetch;

        await expect(
            deployToCloud(
                { apiUrl: "https://cloud", bundle: "b", deployKey: "x", fetch: fetchImpl, manifest: { bindings: [] }, projectId: "p", scriptName: "s" },
                () => {},
            ),
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

describe(collectAssets, () => {
    let directory: string;

    const write = (path: string, content: string): void => {
        mkdirSync(join(directory, path, ".."), { recursive: true });
        writeFileSync(join(directory, path), content);
    };

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), "lunora-cloud-assets-"));
    });

    afterEach(() => {
        rmSync(directory, { force: true, recursive: true });
    });

    it("keys files by URL path, base64-encodes them, and carries only the serving config", () => {
        expect.assertions(1);

        write("index.html", "<h1>hi</h1>");
        write("assets/app.js", "console.log(1)");
        write("_headers", "/*\n  x-a: b");

        const upload = collectAssets(directory, {
            binding: "ASSETS",
            directory: "./public",
            html_handling: "none",
            not_found_handling: "single-page-application",
            run_worker_first: ["/api/*"],
        });

        expect({ ...upload, files: upload.files.toSorted((a, b) => a.path.localeCompare(b.path)) }).toStrictEqual({
            config: { html_handling: "none", not_found_handling: "single-page-application", run_worker_first: ["/api/*"] },
            files: [
                { content: Buffer.from("console.log(1)").toString("base64"), path: "/assets/app.js" },
                { content: Buffer.from("<h1>hi</h1>").toString("base64"), path: "/index.html" },
            ],
        });
    });

    it("omits config when wrangler sets none of the serving keys", () => {
        expect.assertions(1);

        write("index.html", "x");

        expect(collectAssets(directory, { directory: "public" })).toStrictEqual({ files: [{ content: "eA==", path: "/index.html" }] });
    });

    it("honours .assetsignore globs, directory entries, and comments", () => {
        expect.assertions(1);

        write(".assetsignore", "# build noise\n*.map\nprivate/\n/root-only.txt\n");
        write("index.html", "x");
        write("app.js.map", "x");
        write("nested/deep.js.map", "x");
        write("private/secret.txt", "x");
        write("root-only.txt", "x");
        write("nested/root-only.txt", "x");

        expect(
            collectAssets(directory, {})
                .files.map((file) => file.path)
                .toSorted((a, b) => a.localeCompare(b)),
        ).toStrictEqual(["/index.html", "/nested/root-only.txt"]);
    });

    it("refuses a missing or empty directory with a build-first hint", () => {
        expect.assertions(2);

        expect(() => collectAssets(join(directory, "missing"), {})).toThrow(/does not exist — build the app first/);
        expect(() => collectAssets(directory, {})).toThrow(/is empty — build the app first/);
    });

    it("refuses a single asset over 25 MiB", () => {
        expect.assertions(1);

        write("big.bin", "");
        truncateSync(join(directory, "big.bin"), 25 * 1024 * 1024 + 1);

        expect(() => collectAssets(directory, {})).toThrow(/"\/big\.bin".*25 MiB/);
    });

    it("refuses a total over 50 MiB", () => {
        expect.assertions(1);

        for (const name of ["a.bin", "b.bin", "c.bin"]) {
            write(name, "");
            truncateSync(join(directory, name), 20 * 1024 * 1024);
        }

        expect(() => collectAssets(directory, {})).toThrow(/exceed the 50 MiB upload cap/);
    });
});

describe(resolveDeployConfigPath, () => {
    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), "lunora-cloud-redirect-"));
    });

    afterEach(() => {
        rmSync(directory, { force: true, recursive: true });
    });

    it("follows .wrangler/deploy/config.json to the built config", () => {
        expect.assertions(1);

        mkdirSync(join(directory, ".wrangler", "deploy"), { recursive: true });
        mkdirSync(join(directory, "dist", "server"), { recursive: true });
        writeFileSync(join(directory, "dist", "server", "wrangler.json"), "{}");
        writeFileSync(join(directory, ".wrangler", "deploy", "config.json"), JSON.stringify({ configPath: "../../dist/server/wrangler.json" }));

        expect(resolveDeployConfigPath(directory)).toBe(join(directory, "dist", "server", "wrangler.json"));
    });

    it("answers undefined without a redirect, or when it points at nothing", () => {
        expect.assertions(2);

        expect(resolveDeployConfigPath(directory)).toBeUndefined();

        mkdirSync(join(directory, ".wrangler", "deploy"), { recursive: true });
        writeFileSync(join(directory, ".wrangler", "deploy", "config.json"), JSON.stringify({ configPath: "../../dist/missing.json" }));

        expect(resolveDeployConfigPath(directory)).toBeUndefined();
    });

    it("falls back when the redirect is not valid JSON", () => {
        expect.assertions(1);

        mkdirSync(join(directory, ".wrangler", "deploy"), { recursive: true });
        writeFileSync(join(directory, ".wrangler", "deploy", "config.json"), "{ half-written");

        expect(resolveDeployConfigPath(directory)).toBeUndefined();
    });
});
