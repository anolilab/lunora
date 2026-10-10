import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The `runtime: "worker"` steps against the REAL wrangler this repo pins —
 * no network, no registry: the project's `node_modules/wrangler` is a link to
 * it. Covers what a stand-in cannot: that `READ_CONFIG_PROGRAM` reads a TOML
 * config through wrangler's own resolver, and that the generated shim survives
 * wrangler's esbuild bundle with the Worker's classes still exported and the
 * fan-out routes answering from its own handlers.
 */

interface WorkerModule {
    READ_CONFIG_PROGRAM: string;
    releaseFromConfig: (input: { config: Record<string, unknown>; configPath: string; log: (line: string) => void }) => {
        assets?: Record<string, unknown>;
        body: Record<string, unknown>;
        main: string;
        queueNames: Record<string, string>;
    };
    shimSource: (input: { main: string; queueNames: Record<string, string> }) => string;
}

// Loaded by URL: plain `.mjs` shipped into the image, with no declaration file.
const { READ_CONFIG_PROGRAM, releaseFromConfig, shimSource } = (await import(new URL("../containers/build/worker.mjs", import.meta.url).href)) as WorkerModule;

const run = promisify(execFile);
const WRANGLER = dirname(createRequire(import.meta.url).resolve("wrangler/package.json"));
const SHIM_RUNTIME = fileURLToPath(new URL("../containers/build/shim-runtime.mjs", import.meta.url));

/** A plain Worker: TOML, string vars, a cron, a queue it produces to and consumes, a Durable Object, and a `[env]` the box must not apply. */
const WRANGLER_TOML = `name = "plain-toml"
main = "src/index.js"
compatibility_date = "2025-06-01"

[vars]
GREETING = "hello"

[triggers]
crons = ["*/5 * * * *"]

[[queues.producers]]
binding = "JOB_QUEUE"
queue = "jobs"

[[queues.consumers]]
queue = "jobs"

[[durable_objects.bindings]]
name = "COUNTER"
class_name = "Counter"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Counter"]

[env.staging.vars]
GREETING = "staging"
`;

/** The Worker: records what its handlers saw on `globalThis.seen`. */
const WORKER_SOURCE = `export class Counter {}

const seen = (globalThis.seen ??= []);

export default {
    async fetch(request, env) {
        return new Response("tenant " + new URL(request.url).pathname + " " + env.GREETING);
    },
    async queue(batch) {
        seen.push(["queue", batch.queue, batch.messages.map((message) => message.id)]);
        batch.messages[0].retry();
    },
    async scheduled(controller, env) {
        seen.push(["scheduled", controller.cron, env.GREETING]);
    },
};
`;

let sandbox: string;
let project: string;
let config: Record<string, unknown>;

describe("build box worker runtime against the pinned wrangler", () => {
    beforeAll(async () => {
        sandbox = await realpath(await mkdtemp(join(tmpdir(), "build-box-wrangler-")));
        project = join(sandbox, "repo");
        await mkdir(join(project, "src"), { recursive: true });
        await mkdir(join(project, "node_modules"), { recursive: true });
        await symlink(WRANGLER, join(project, "node_modules", "wrangler"));
        await writeFile(join(project, "package.json"), JSON.stringify({ name: "plain", private: true }));
        await writeFile(join(project, "wrangler.toml"), WRANGLER_TOML);
        await writeFile(join(project, "src", "index.js"), WORKER_SOURCE);

        const out = join(sandbox, "config.json");

        // The workspace root is where the linked wrangler really lives: the program refuses one outside it.
        await run(
            process.execPath,
            ["--input-type=module", "--eval", READ_CONFIG_PROGRAM, "--", project, join(project, "wrangler.toml"), await realpath(join(WRANGLER, "../..")), out],
            {
                cwd: project,
            },
        );
        ({ config } = JSON.parse(await readFile(out, "utf8")) as { config: Record<string, unknown> });
    }, 60_000);

    afterAll(async () => {
        await rm(sandbox, { force: true, recursive: true });
    });

    it("reads a TOML config through wrangler's resolver: main absolute, top-level env only, no defaults it never declared", () => {
        expect.assertions(2);

        expect(config).toStrictEqual({
            compatibility_date: "2025-06-01",
            durable_objects: { bindings: [{ class_name: "Counter", name: "COUNTER" }] },
            main: join(project, "src", "index.js"),
            migrations: [{ new_sqlite_classes: ["Counter"], tag: "v1" }],
            name: "plain-toml",
            queues: { consumers: [{ queue: "jobs" }], producers: [{ binding: "JOB_QUEUE", queue: "jobs" }] },
            triggers: { crons: ["*/5 * * * *"] },
            vars: { GREETING: "hello" },
        });
        expect(config).not.toHaveProperty("env");
    });

    it("translates it into the release a Lunora deploy would carry, plus its vars", async () => {
        expect.assertions(1);

        const { body, queueNames } = releaseFromConfig({ config, configPath: join(project, "wrangler.toml"), log: () => {} });

        expect({ body, queueNames }).toStrictEqual({
            body: {
                cronSpecs: ["*/5 * * * *"],
                manifest: {
                    bindings: [
                        { binding: "COUNTER", className: "Counter", sqlite: true, type: "durable_object" },
                        { binding: "jobs", resource: "jobs", type: "queue_consumer" },
                        { binding: "JOB_QUEUE", resource: "jobs", type: "queue_producer" },
                    ],
                    compatibilityDate: "2025-06-01",
                    vars: { GREETING: "hello" },
                },
                scriptName: "plain-toml",
            },
            queueNames: { "--job-queue": "jobs" },
        });
    });

    it("bundles the shim with wrangler into one module that keeps the Worker's classes and answers the fan-out routes", async () => {
        expect.assertions(6);

        const { main, queueNames } = releaseFromConfig({ config, configPath: join(project, "wrangler.toml"), log: () => {} });
        const entry = join(sandbox, "scratch", "entry");
        const outdir = join(sandbox, "scratch", "out");

        await mkdir(entry, { recursive: true });
        await writeFile(join(entry, "shim-runtime.mjs"), await readFile(SHIM_RUNTIME));
        await writeFile(join(entry, "index.mjs"), shimSource({ main, queueNames }));
        await run(
            process.execPath,
            [
                join(WRANGLER, "bin", "wrangler.js"),
                "deploy",
                join(entry, "index.mjs"),
                "--config",
                join(project, "wrangler.toml"),
                "--dry-run",
                "--outdir",
                outdir,
            ],
            { cwd: project, env: { ...process.env, WRANGLER_HIDE_BANNER: "true", WRANGLER_LOG_PATH: join(sandbox, "logs"), WRANGLER_SEND_METRICS: "false" } },
        );

        const bundle = (await import(pathToFileURL(join(outdir, "index.js")).href)) as Record<string, unknown> & {
            default: { fetch: (request: Request, env: unknown, context: unknown) => Promise<Response> };
        };
        const env = { GREETING: "hello", LUNORA_ADMIN_TOKEN: "t" };
        const admin = (path: string, body: unknown): Request =>
            new Request(`https://tenant.internal${path}`, { body: JSON.stringify(body), headers: { authorization: "Bearer t" }, method: "POST" });

        const passed = await bundle.default.fetch(new Request("https://app.example/hi"), env, {});
        const scheduled = await bundle.default.fetch(admin("/_lunora/scheduled", { cron: "*/5 * * * *" }), env, {});
        const queued = await bundle.default.fetch(
            admin("/_lunora/queue", {
                messages: [
                    { body: 1, id: "m1" },
                    { body: 2, id: "m2" },
                ],
                queue: "plain-toml--job-queue",
            }),
            env,
            {},
        );
        // A deployment with no admin token admits nobody.
        const refused = await bundle.default.fetch(admin("/_lunora/scheduled", { cron: "x" }), { GREETING: "hello" }, {});

        // The Durable Object class is still an export of the deployed module.
        expect(typeof bundle["Counter"]).toBe("function");
        await expect(passed.text()).resolves.toBe("tenant /hi hello");
        await expect(scheduled.json()).resolves.toStrictEqual({ cron: "*/5 * * * *", ok: true });
        await expect(queued.json()).resolves.toStrictEqual({ retry: ["m1"] });
        expect(refused.status).toBe(403);
        expect((globalThis as { seen?: unknown[] }).seen).toStrictEqual([
            ["scheduled", "*/5 * * * *", "hello"],
            ["queue", "jobs", ["m1", "m2"]],
        ]);
    }, 60_000);
});
