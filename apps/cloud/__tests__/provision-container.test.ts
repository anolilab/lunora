import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ProvisionEvent } from "../src/targets/cloudflare-wfp/box-contract";

/**
 * The provision box's HTTP contract, with Alchemy stubbed.
 *
 * `LUNORA_ALCHEMY_CLI` points the server at `__fixtures__/alchemy-stub.mjs`, which
 * reports what it was given (argv, stack, the bundle on disk, whether secrets
 * reached it) and misbehaves on cue. Real Cloudflare is never touched.
 */

const SERVER = fileURLToPath(new URL("../containers/provision/server.mjs", import.meta.url));

const STUB = fileURLToPath(new URL("../__fixtures__/alchemy-stub.mjs", import.meta.url));

let child: ReturnType<typeof spawn>;
let origin: string;

const deployJob = (dispatchNamespace = "lunora-production") => {
    return {
        action: "deploy",
        spec: {
            alias: "acme",
            assets: { files: [{ content: Buffer.from("<h1>hi</h1>").toString("base64"), path: "/index.html" }] },
            bundle: Buffer.from("export default { fetch() {} }").toString("base64"),
            cell: "cell-1",
            dispatchNamespace,
            manifest: { bindings: [{ binding: "DB", resourceName: "acme-db", type: "d1" }] },
            secrets: { API_KEY: "s3cret-value" },
            tags: ["org:o1"],
        },
    };
};

const post = (body: unknown): Promise<Response> =>
    fetch(`${origin}/__lunora/provision`, {
        body: typeof body === "string" ? body : JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

const events = async (response: Response): Promise<ProvisionEvent[]> => {
    const text = await response.text();

    return text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as ProvisionEvent);
};

const reports = (stream: ProvisionEvent[]) =>
    stream.flatMap((event) => (event.type === "log" && event.line.startsWith("{") ? [JSON.parse(event.line) as Record<string, unknown>] : []));

// Every job spawns Node twice; generous so a loaded CI runner does not flake.
describe("provision box", { timeout: 20_000 }, () => {
    beforeAll(async () => {
        child = spawn(process.execPath, [SERVER], {
            env: { ...process.env, CLOUDFLARE_API_TOKEN: "cf-token-value", LUNORA_ALCHEMY_CLI: STUB, LUNORA_CONTROL_PLANE_SCRIPT: "lunora-cloud", PORT: "0" },
            stdio: ["ignore", "pipe", "inherit"],
        });

        for await (const chunk of child.stdout ?? []) {
            const port = /listening on (\d+)/u.exec(String(chunk))?.[1];

            if (port !== undefined) {
                origin = `http://127.0.0.1:${port}`;
                break;
            }
        }
    }, 20_000);

    afterAll(async () => {
        child.kill("SIGKILL");
        await once(child, "close");
    });

    it("answers the health probe", async () => {
        expect.assertions(1);

        const response = await fetch(`${origin}/__lunora/health`);

        expect(response.status).toBe(200);
    });

    it("deploys the project stack, then the Worker, and ends with exactly one result", async () => {
        expect.assertions(6);

        const response = await post(deployJob());
        const stream = await events(response);
        const [project, worker] = reports(stream);

        expect(response.headers.get("content-type")).toBe("application/x-ndjson");
        expect(project).toMatchObject({
            args: ["deploy", expect.stringMatching(/program\.mjs$/u), "--stage", "lunora-production", "--yes", "--no-input"],
            stack: "project",
        });
        // Secrets reach only the worker step; the bundle is on disk for Alchemy to upload.
        expect([project?.hasSecrets, worker?.hasSecrets]).toStrictEqual([false, true]);
        expect(worker?.bundle).toBe("export default { fetch() {} }");
        expect(stream.filter((event) => event.type !== "log")).toStrictEqual([{ type: "result" }]);
        // The workspace is removed once the job ends.
        expect(existsSync(String(worker?.cwd))).toBe(false);
    });

    it("never lets a secret value or the API token out in a log line", async () => {
        expect.assertions(2);

        const text = JSON.stringify(await events(await post(deployJob())));

        expect(text).not.toContain("s3cret-value");
        expect(text).toContain("echoing [redacted]");
    });

    it("destroys the Worker, then the project", async () => {
        expect.assertions(2);

        const stream = await events(await post({ action: "destroy", alias: "acme", dispatchNamespace: "lunora-production" }));

        expect(reports(stream).map((report) => [(report.args as string[])[0], report.stack])).toStrictEqual([
            ["destroy", "worker"],
            ["destroy", "project"],
        ]);
        expect(stream.at(-1)).toStrictEqual({ type: "result" });
    });

    it("ends with an error, and no result, when an Alchemy step fails", async () => {
        expect.assertions(1);

        const stream = await events(await post(deployJob("lunora-fail")));

        expect(stream.filter((event) => event.type !== "log")).toStrictEqual([
            { message: "alchemy deploy of lunora-worker-acme failed with exit code 3", type: "error" },
        ]);
    });

    it("refuses an invalid job as an error event, before running anything", async () => {
        expect.assertions(1);

        const job = deployJob();

        job.spec.manifest.bindings = [{ binding: "FLOW", resourceName: "x", type: "workflow" }];

        await expect(events(await post(job))).resolves.toStrictEqual([
            { message: "workflow binding FLOW: Workflows cannot be registered for a Workers for Platforms script yet", type: "error" },
        ]);
    });

    it("refuses a hostile asset path before writing anything", async () => {
        expect.assertions(1);

        const job = deployJob();

        job.spec.assets.files = [{ content: "", path: "/../../etc/passwd" }];

        await expect(events(await post(job))).resolves.toStrictEqual([{ message: 'asset path "/../../etc/passwd" is not valid', type: "error" }]);
    });

    it("rejects a body that is not JSON with a 400", async () => {
        expect.assertions(1);

        const response = await post("{not json");

        expect(response.status).toBe(400);
    });

    it("runs one job at a time and answers 409 while busy", async () => {
        expect.assertions(3);

        const first = post(deployJob("lunora-slow"));

        // Let the first request claim the instance.
        await sleep(300);

        const second = await post(deployJob());

        expect(second.status).toBe(409);

        const firstEvents = await events(await first);

        expect(firstEvents.at(-1)).toStrictEqual({ type: "result" });

        const third = await post(deployJob());

        expect(third.status).toBe(200);
    });

    it("answers 404 for anything else", async () => {
        expect.assertions(1);

        const response = await fetch(`${origin}/__lunora/exec`, { method: "POST" });

        expect(response.status).toBe(404);
    });
});
