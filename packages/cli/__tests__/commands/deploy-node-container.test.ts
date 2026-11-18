import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runDeployCommand } from "../../src/commands/deploy/handler";
import { NODE_DEPLOY_DIRECTORY, NODE_IMAGE } from "../../src/commands/deploy/node-container";
import type { DeployCommandOptions } from "../../src/commands/deploy/types";
import type { Logger } from "../../src/util/logger";
import type { SpawnDescriptor, Spawner } from "../../src/util/spawn";
import { defaultSpawner } from "../../src/util/spawn";

/** This package's node_modules: the fixture links it so `@lunora/*` and esbuild resolve to the workspace copies. */
const PACKAGE_NODE_MODULES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules");

/** The `better-sqlite3` the workspace's platform-node runs on, linked into the artifact in place of the image's `npm install`. */
const BETTER_SQLITE3 = dirname(createRequire(join(PACKAGE_NODE_MODULES, "@lunora", "platform-node", "package.json")).resolve("better-sqlite3/package.json"));

/** Values that must never reach a generated file, though the deploy runs with them in its environment and `.dev.vars`. */
const SECRET_VALUES = { SESSION_SECRET: "session-value-7f3a91", STRIPE_KEY: "sk_test_value_4c2e88" };

/** A server run on the shared deploy: the server reads every one, so an absent one changes what the test sees. */
const RUN_ENV = { SESSION_SECRET: "session-at-runtime" };

/** A whole run waits on a held request or a shutdown milestone; a broken shutdown fails here rather than hanging. */
const SERVER_TEST_TIMEOUT = 30_000;

const recordingLogger = (): { logger: Logger; warnings: string[] } => {
    const warnings: string[] = [];

    return {
        logger: {
            error: () => {},
            info: () => {},
            success: () => {},
            warn: (message) => {
                warnings.push(message);
            },
        },
        warnings,
    };
};

/**
 * Stands in for `npm install --package-lock-only`, which resolves from the registry: a lockfile derived from the manifest
 * alone, so the suite needs no network. The local-only Docker test runs the real npm.
 */
const fakeNpm =
    (calls: SpawnDescriptor[] = []): Spawner =>
    async (descriptor) => {
        calls.push(descriptor);

        if (descriptor.command === "npm" && descriptor.args.includes("--package-lock-only") && descriptor.cwd !== undefined) {
            const manifest = JSON.parse(readFileSync(join(descriptor.cwd, "package.json"), "utf8")) as { dependencies: Record<string, string>; name: string };
            const packages = Object.fromEntries(Object.entries(manifest.dependencies).map(([name, version]) => [`node_modules/${name}`, { version }]));

            writeFileSync(
                join(descriptor.cwd, "package-lock.json"),
                `${JSON.stringify({ lockfileVersion: 3, name: manifest.name, packages: { "": { dependencies: manifest.dependencies, name: manifest.name }, ...packages }, requires: true }, undefined, 2)}\n`,
                "utf8",
            );
        }

        return { code: 0 };
    };

/** The `ws` the workspace's platform-node runs on, linked into a fixture whose worker imports it directly. */
const WS_PACKAGE = dirname(createRequire(join(PACKAGE_NODE_MODULES, "@lunora", "platform-node", "package.json")).resolve("ws/package.json"));

interface FixtureOptions {
    /** Extra packages the fixture's node_modules carries, by name, beside everything this package installs. */
    extraModules?: Record<string, string>;
    /** `lunora({ schemaDir })` in a parsed-only vite.config.ts, and the directory the functions live in. */
    schemaDir?: string;
    /** Merged over the fixture's wrangler config. */
    wrangler?: Record<string, unknown>;
}

const WORKER_SOURCE = (schemaDir: string): string => `import { writeFileSync } from "node:fs";

import { createWorker } from "@lunora/runtime";

import { createShardDO } from "../${schemaDir}/_generated/shard.js";

export const ShardDO = createShardDO();

let worker: ReturnType<typeof createWorker> | undefined;

interface Context {
    waitUntil: (promise: Promise<unknown>) => void;
}

const held = async (url: string | null): Promise<string> => (await fetch(String(url))).text();

export default {
    async fetch(request: Request, env: Record<string, unknown> & { SHARD: never }, ctx: Context): Promise<Response> {
        const url = new URL(request.url);

        // Fixture-only probes for the generated server's runtime behaviour.
        switch (url.pathname) {
            case "/__fixture/env":
                return Response.json({ flags: env.FLAGS, limit: env.LIMIT });
            case "/__fixture/bindings":
                return Response.json({
                    admin: env.LUNORA_ADMIN_TOKEN ?? null,
                    hostSecret: env.AWS_SECRET_ACCESS_KEY ?? null,
                    path: "PATH" in env,
                    session: env.SESSION_SECRET ?? null,
                    stripe: typeof (env.STRIPE_KEY as { get?: unknown } | undefined)?.get,
                });
            case "/__fixture/background-fail":
                ctx.waitUntil(Promise.reject(new Error("background boom", { cause: new Error("root cause of the boom") })));

                return new Response("accepted");
            case "/__fixture/unhandled":
                void Promise.reject(new Error("unhandled boom", { cause: new Error("deep cause") }));

                return new Response("accepted");
            case "/__fixture/slow":
                return new Response(await held(url.searchParams.get("hold")));
            case "/__fixture/slow-then-reject": {
                const text = await held(url.searchParams.get("hold"));

                // A fatal error raised while the server is already shutting down.
                void Promise.reject(new Error("late failure during shutdown"));

                return new Response(text);
            }
            case "/__fixture/nested":
                // Background work that registers more background work while it runs.
                ctx.waitUntil(
                    Promise.resolve().then(() => {
                        ctx.waitUntil(held(url.searchParams.get("hold")).then((text) => writeFileSync(String(url.searchParams.get("marker")), text)));
                    }),
                );

                return new Response("accepted");
            default:
                worker ??= createWorker({ shardDO: env.SHARD });

                return worker.fetch(request, env, ctx as never);
        }
    },
};
`;

/** The fixture's node_modules: this package's own, plus any extras by name (a scoped name replaces just that package). */
const linkModules = (root: string, extraModules: Record<string, string> | undefined): void => {
    if (extraModules === undefined) {
        symlinkSync(PACKAGE_NODE_MODULES, join(root, "node_modules"), "dir");

        return;
    }

    // A directory of links rather than one link, so the extras sit beside this package's own modules without touching them.
    mkdirSync(join(root, "node_modules"));

    const scopes = new Set(Object.keys(extraModules).flatMap((name) => (name.startsWith("@") ? [name.split("/")[0] ?? ""] : [])));

    for (const entry of readdirSync(PACKAGE_NODE_MODULES)) {
        if (scopes.has(entry)) {
            // A scope with an override is a directory of links too, so one package in it can be replaced.
            mkdirSync(join(root, "node_modules", entry));

            for (const scoped of readdirSync(join(PACKAGE_NODE_MODULES, entry)).filter((name) => extraModules[`${entry}/${name}`] === undefined)) {
                symlinkSync(join(PACKAGE_NODE_MODULES, entry, scoped), join(root, "node_modules", entry, scoped));
            }
        } else {
            symlinkSync(join(PACKAGE_NODE_MODULES, entry), join(root, "node_modules", entry));
        }
    }

    for (const [name, path] of Object.entries(extraModules)) {
        symlinkSync(path, join(root, "node_modules", name), "dir");
    }
};

const writeFixture = (root: string, options: FixtureOptions = {}): void => {
    const schemaDir = options.schemaDir ?? "lunora";

    mkdirSync(join(root, schemaDir));
    mkdirSync(join(root, "src"));
    linkModules(root, options.extraModules);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "node-container-app", private: true, type: "module" }), "utf8");
    writeFileSync(join(root, "lunora.config.ts"), `export default { target: "node" };\n`, "utf8");
    writeFileSync(
        join(root, ".dev.vars"),
        Object.entries(SECRET_VALUES)
            .map(([name, value]) => `${name}=${value}\n`)
            .join(""),
        "utf8",
    );

    if (options.schemaDir !== undefined) {
        writeFileSync(
            join(root, "vite.config.ts"),
            `import { lunora } from "@lunora/vite";\n\nexport default { plugins: [lunora({ schemaDir: ${JSON.stringify(options.schemaDir)} })] };\n`,
            "utf8",
        );
    }

    writeFileSync(
        join(root, "wrangler.jsonc"),
        JSON.stringify({
            compatibility_date: "2026-10-01",
            durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
            main: "src/worker.ts",
            migrations: [{ new_sqlite_classes: ["ShardDO"], tag: "v1" }],
            name: "node-container-app",
            secrets: { required: ["SESSION_SECRET"] },
            secrets_store_secrets: [{ binding: "STRIPE_KEY", secret_name: "stripe", store_id: "store" }],
            vars: { FLAGS: { enabled: true }, LIMIT: 3 },
            ...options.wrangler,
        }),
        "utf8",
    );
    writeFileSync(
        join(root, schemaDir, "schema.ts"),
        `import { defineSchema, defineTable, v } from "@lunora/server";\n\nexport default defineSchema({ notes: defineTable({ text: v.string() }) });\n`,
        "utf8",
    );
    writeFileSync(
        join(root, schemaDir, "notes.ts"),
        `import { mutation, query, v } from "./_generated/server.js";

export const greeting = query.query(async (): Promise<string> => "from the container");

export const add = mutation.input({ text: v.string() }).mutation(async ({ args, ctx }) => ctx.db.insert("notes", { text: args.text }));
`,
        "utf8",
    );
    writeFileSync(join(root, "src", "worker.ts"), WORKER_SOURCE(schemaDir), "utf8");
};

const newWorkdir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "lunora-cli-node-deploy-")));

const deploy = async (cwd: string, options: Partial<DeployCommandOptions> = {}): ReturnType<typeof runDeployCommand> => {
    const { logger } = recordingLogger();

    return runDeployCommand({ cwd, interactive: false, logger, spawner: fakeNpm(), target: "node", ...options });
};

const callFunction = async (origin: string, functionPath: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const response = await fetch(`${origin}/_lunora/rpc`, {
        body: JSON.stringify({ args, functionPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

    return response.json();
};

/** A running `server.mjs`, with milestones on its output. None of them is a timer. */
interface ServerRun {
    child: ChildProcess;
    exited: Promise<number | null>;
    /** The origin from the listening line, or a rejection when the process exits first. */
    listening: Promise<string>;
    stderr: () => string;
    stdout: () => string;
    /** Resolves once `text` appears on stdout; rejects when the process exits first. */
    waitForStdout: (text: string) => Promise<void>;
}

const startServer = (artifact: string, dataDirectory: string, env: Record<string, string> = RUN_ENV, nodeArguments: string[] = []): ServerRun => {
    const child = spawn(process.execPath, [...nodeArguments, "server.mjs"], {
        cwd: artifact,
        env: { LUNORA_DATA_DIR: dataDirectory, PATH: process.env.PATH, PORT: "0", ...env },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const watchers: { reject: (error: Error) => void; resolve: () => void; text: string }[] = [];

    const settleWatchers = (): void => {
        for (const watcher of watchers.filter((candidate) => stdout.includes(candidate.text))) {
            watchers.splice(watchers.indexOf(watcher), 1);
            watcher.resolve();
        }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        settleWatchers();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
    });

    const exited = new Promise<number | null>((resolve) => {
        child.once("exit", (code) => {
            for (const watcher of watchers.splice(0)) {
                watcher.reject(new Error(`server.mjs exited with ${String(code)} before printing "${watcher.text}":\n${stderr}`));
            }

            resolve(code);
        });
    });

    const waitForStdout = async (text: string): Promise<void> =>
        new Promise<void>((resolve, reject) => {
            watchers.push({ reject, resolve, text });
            settleWatchers();
        });

    const listening = waitForStdout("lunora: listening on ").then(() => /lunora: listening on (\S+)/u.exec(stdout)?.[1] ?? "");

    // A test that expects an early exit never awaits this one.
    listening.catch(() => undefined);

    return { child, exited, listening, stderr: () => stderr, stdout: () => stdout, waitForStdout };
};

/** A local origin that holds each request until the test releases it: work "in flight" for exactly as long as the test needs. */
const holdServer = async (): Promise<{ arrived: Promise<void>; close: () => Promise<void>; release: (body: string) => void; url: string }> => {
    let arrive: () => void = () => {};
    let release: (body: string) => void = () => {};
    const arrived = new Promise<void>((resolve) => {
        arrive = resolve;
    });
    const released = new Promise<string>((resolve) => {
        release = resolve;
    });
    const server: Server = createServer((_request, response) => {
        arrive();
        const answer = async (): Promise<void> => {
            response.end(await released);
        };

        answer().catch(() => undefined);
    });

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    return {
        arrived,
        close: async () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => {
                    resolve();
                });
            }),
        release,
        url: `http://127.0.0.1:${String(port)}/`,
    };
};

const dockerAvailable = (): boolean => {
    try {
        // eslint-disable-next-line sonarjs/no-os-command-from-path -- the engine resolves from PATH; fixed args, no shell
        return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
    } catch {
        return false;
    }
};

describe("lunora deploy --target node", () => {
    describe("the generated server", () => {
        let workdir: string;
        let artifact: string;
        let result: Awaited<ReturnType<typeof runDeployCommand>>;
        let runs: number;

        /** A data directory of its own per run, so no run reads another's shards. */
        const dataDirectory = (): string => {
            runs += 1;

            return join(workdir, `data-${String(runs)}`);
        };

        beforeAll(async () => {
            runs = 0;
            workdir = newWorkdir();
            writeFixture(workdir);

            const savedEnv: Record<string, string | undefined> = {};

            // The deploy runs with the secret values in its own environment too: none may reach a generated file.
            for (const [name, value] of Object.entries(SECRET_VALUES)) {
                savedEnv[name] = process.env[name];
                process.env[name] = value;
            }

            try {
                result = await deploy(workdir);
            } finally {
                for (const [name, value] of Object.entries(savedEnv)) {
                    if (value === undefined) {
                        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- restoring the variable this suite set
                        delete process.env[name];
                    } else {
                        process.env[name] = value;
                    }
                }
            }

            artifact = join(workdir, NODE_DEPLOY_DIRECTORY);

            if (result.code === 0) {
                mkdirSync(join(artifact, "node_modules"));
                symlinkSync(BETTER_SQLITE3, join(artifact, "node_modules", "better-sqlite3"), "dir");
            }
        }, SERVER_TEST_TIMEOUT);

        afterAll(() => {
            rmSync(workdir, { force: true, recursive: true });
        });

        it("writes the six files, and the server serves a query and a write when run with node", async () => {
            expect.assertions(9);
            expect(result).toMatchObject({ code: 0, container: { directory: artifact } });

            for (const file of [".dockerignore", "Dockerfile", "package-lock.json", "package.json", "README.md", "server.mjs"]) {
                expect(existsSync(join(artifact, file)), file).toBe(true);
            }

            const data = dataDirectory();
            const run = startServer(artifact, data);

            try {
                const origin = await run.listening;

                await expect(callFunction(origin, "notes:greeting")).resolves.toStrictEqual({ result: "from the container" });
                // A write lands in the shard's SQLite under LUNORA_DATA_DIR, so the request reached a real ShardDO.
                await expect(callFunction(origin, "notes:add", { text: "hello" })).resolves.toStrictEqual({ result: expect.any(String) });
            } finally {
                run.child.kill("SIGTERM");
                await run.exited;
            }
        });

        it("pins the base image by digest, runs as the non-root node user and hands it the /data volume", () => {
            expect.assertions(4);

            const buildFile = readFileSync(join(artifact, "Dockerfile"), "utf8");

            expect(NODE_IMAGE).toMatch(/^node:\d+\.\d+\.\d+-bookworm-slim@sha256:[\da-f]{64}$/u);
            expect(buildFile.match(/^FROM .*/gmu)).toStrictEqual([`FROM ${NODE_IMAGE} AS build`, `FROM ${NODE_IMAGE}`]);
            // The chown must come before USER and VOLUME: a change to a declared volume after VOLUME is discarded.
            expect(buildFile.indexOf("chown node:node /data")).toBeLessThan(buildFile.indexOf("USER node"));
            expect(buildFile.indexOf("USER node")).toBeLessThan(buildFile.indexOf('VOLUME ["/data"]'));
        });

        it("sends only what the Dockerfile copies to a builder", () => {
            expect.assertions(1);

            const rules = readFileSync(join(artifact, ".dockerignore"), "utf8")
                .split("\n")
                .filter((line) => line !== "" && !line.startsWith("#"));

            expect(rules).toStrictEqual(["*", "!package.json", "!package-lock.json", "!server.mjs"]);
        });

        it("names the secrets in the README but bakes no secret value into any generated file", () => {
            expect.assertions(7);

            const files = readdirSync(artifact).filter((file) => file !== "node_modules");
            const contents = files.map((file) => readFileSync(join(artifact, file), "utf8")).join("\n");
            const readme = readFileSync(join(artifact, "README.md"), "utf8");

            expect(readme).toContain("`STRIPE_KEY`");
            expect(readme).toContain("`SESSION_SECRET`");
            // Truthful about what is bundled: secrets by name only, vars by value.
            expect(readme).toContain("No secret value is written into `server.mjs`");
            expect(readme).toContain("values are bundled into `server.mjs` as defaults");
            // Honest about the boundary: env holds declared names only, but process.env is readable to anything in the process.
            expect(readme).toContain("No other variable is passed through `env`");
            expect(readme).toContain(
                "`process.env` stays readable to the app and every\ndependency in this process, so inject only the variables the app needs",
            );
            expect(Object.values(SECRET_VALUES).filter((value) => contents.includes(value))).toStrictEqual([]);
        });

        it("hands the worker structured wrangler vars as Cloudflare does, not their JSON text", async () => {
            expect.assertions(1);

            const run = startServer(artifact, dataDirectory());

            try {
                const origin = await run.listening;
                const response = await fetch(`${origin}/__fixture/env`);

                await expect(response.json()).resolves.toStrictEqual({ flags: { enabled: true }, limit: 3 });
            } finally {
                run.child.kill("SIGTERM");
                await run.exited;
            }
        });

        it("hands the worker only declared names, keeping a host's other variables out of env", async () => {
            expect.assertions(1);

            const run = startServer(artifact, dataDirectory(), {
                ...RUN_ENV,
                // Injected by a container host for something else entirely; the app never declared it.
                AWS_SECRET_ACCESS_KEY: "host-credential-91c0",
                LUNORA_ADMIN_TOKEN: "admin-token",
                STRIPE_KEY: "sk_runtime",
            });

            try {
                const origin = await run.listening;
                const response = await fetch(`${origin}/__fixture/bindings`);

                await expect(response.json()).resolves.toStrictEqual({
                    admin: "admin-token",
                    hostSecret: null,
                    path: false,
                    session: "session-at-runtime",
                    stripe: "function",
                });
            } finally {
                run.child.kill("SIGTERM");
                await run.exited;
            }
        });

        it.each(["8s", "10_000", "", "-1", "2147483648"])(
            "refuses to start when LUNORA_SHUTDOWN_TIMEOUT_MS is %j, instead of skipping the drain",
            async (value) => {
                expect.assertions(2);

                const run = startServer(artifact, dataDirectory(), { ...RUN_ENV, LUNORA_SHUTDOWN_TIMEOUT_MS: value });
                const outcome = await Promise.race([run.listening.then(() => "listening"), run.exited.then((code) => `exit ${String(code)}`)]);

                run.child.kill("SIGKILL");
                await run.exited;

                expect(outcome).toBe("exit 1");
                expect(run.stderr()).toContain(
                    `LUNORA_SHUTDOWN_TIMEOUT_MS must be a whole number of milliseconds from 0 to 2147483647, such as 8000, and it is ${JSON.stringify(value)}`,
                );
            },
        );

        it("refuses to start without a secrets.required variable, naming it", async () => {
            expect.assertions(2);

            const run = startServer(artifact, dataDirectory(), {});
            const outcome = await Promise.race([run.listening.then(() => "listening"), run.exited.then((code) => `exit ${String(code)}`)]);

            run.child.kill("SIGKILL");
            await run.exited;

            expect(outcome).toBe("exit 1");
            expect(run.stderr()).toContain("SESSION_SECRET");
        });

        it("prints the public URL alongside the bind address", async () => {
            expect.assertions(1);

            const run = startServer(artifact, dataDirectory(), { ...RUN_ENV, HOST: "127.0.0.1", LUNORA_ORIGIN_URL: "https://app.example" });

            try {
                await run.listening;

                expect(run.stdout()).toMatch(/lunora: listening on http:\/\/127\.0\.0\.1:\d+ \(public URL https:\/\/app\.example\)/u);
            } finally {
                run.child.kill("SIGTERM");
                await run.exited;
            }
        });

        it(
            "logs a failed waitUntil with its stack and cause instead of dropping it",
            async () => {
                expect.assertions(4);

                const run = startServer(artifact, dataDirectory());
                const origin = await run.listening;

                await expect(fetch(`${origin}/__fixture/background-fail`).then(async (response) => response.text())).resolves.toBe("accepted");

                // Shutdown drains background work, so the failure is on stderr by the time the process has exited.
                run.child.kill("SIGTERM");
                await run.exited;

                expect(run.stderr()).toContain("lunora: work handed to waitUntil failed");
                expect(run.stderr()).toMatch(/Error: background boom\n\s+at /u);
                expect(run.stderr()).toContain("root cause of the boom");
            },
            SERVER_TEST_TIMEOUT,
        );

        it(
            "logs an unhandled rejection with its cause, then shuts down with a failure code",
            async () => {
                expect.assertions(4);

                const run = startServer(artifact, dataDirectory());
                const origin = await run.listening;

                await fetch(`${origin}/__fixture/unhandled`);

                await expect(run.exited).resolves.toBe(1);
                expect(run.stderr()).toContain("lunora: unhandled rejection");
                expect(run.stderr()).toMatch(/Error: unhandled boom\n\s+at /u);
                expect(run.stderr()).toContain("deep cause");
            },
            SERVER_TEST_TIMEOUT,
        );

        it(
            "lets a request in flight at SIGTERM finish, then exits cleanly",
            async () => {
                expect.assertions(3);

                const hold = await holdServer();
                const run = startServer(artifact, dataDirectory());

                try {
                    const origin = await run.listening;
                    const response = fetch(`${origin}/__fixture/slow?hold=${encodeURIComponent(hold.url)}`).then(async (reply) => {
                        return {
                            body: await reply.text(),
                            status: reply.status,
                        };
                    });

                    await hold.arrived;
                    run.child.kill("SIGTERM");
                    // The signal has been handled and the server is draining; only now does the held request get its answer.
                    await run.waitForStdout("lunora: shutting down");
                    hold.release("held reply");

                    await expect(response).resolves.toStrictEqual({ body: "held reply", status: 200 });
                    await expect(run.exited).resolves.toBe(0);
                    expect(run.stdout()).toContain("lunora: stopped");
                } finally {
                    run.child.kill("SIGKILL");
                    await hold.close();
                }
            },
            SERVER_TEST_TIMEOUT,
        );

        it(
            "still drains and closes every database when an earlier shutdown step fails",
            async () => {
                expect.assertions(5);

                // Fault injection from outside the product: a preload makes the HTTP server's close report a failure.
                const preload = join(workdir, "failing-close.mjs");

                writeFileSync(
                    preload,
                    `import { Server } from "node:http";\nconst close = Server.prototype.close;\nServer.prototype.close = function (callback) {\n    close.call(this);\n    callback?.(new Error("injected close failure"));\n    return this;\n};\n`,
                    "utf8",
                );

                const data = dataDirectory();
                const run = startServer(artifact, data, RUN_ENV, ["--import", preload]);
                const origin = await run.listening;

                // A write opens the shard's database in WAL mode; only a clean close removes its -wal file.
                await expect(callFunction(origin, "notes:add", { text: "kept" })).resolves.toStrictEqual({ result: expect.any(String) });

                run.child.kill("SIGTERM");

                await expect(run.exited).resolves.toBe(1);
                expect(run.stderr()).toContain("lunora: closing the HTTP server failed during shutdown");
                expect(run.stdout()).toContain("lunora: stopped");
                expect(readdirSync(data, { recursive: true }).filter((file) => String(file).endsWith("-wal"))).toStrictEqual([]);
            },
            SERVER_TEST_TIMEOUT,
        );

        it(
            "exits non-zero when a fatal error arrives during a shutdown that began cleanly",
            async () => {
                expect.assertions(2);

                const hold = await holdServer();
                const run = startServer(artifact, dataDirectory());

                try {
                    const origin = await run.listening;

                    fetch(`${origin}/__fixture/slow-then-reject?hold=${encodeURIComponent(hold.url)}`).catch(() => undefined);
                    await hold.arrived;
                    run.child.kill("SIGTERM");
                    await run.waitForStdout("lunora: shutting down");
                    // Releasing the held request raises an unhandled rejection inside the running shutdown.
                    hold.release("released");

                    await expect(run.exited).resolves.toBe(1);
                    expect(run.stderr()).toContain("late failure during shutdown");
                } finally {
                    run.child.kill("SIGKILL");
                    await hold.close();
                }
            },
            SERVER_TEST_TIMEOUT,
        );

        it(
            "stops waiting at the shutdown deadline, naming the request it cut off",
            async () => {
                expect.assertions(2);

                const hold = await holdServer();
                const run = startServer(artifact, dataDirectory(), { ...RUN_ENV, LUNORA_SHUTDOWN_TIMEOUT_MS: "0" });

                try {
                    const origin = await run.listening;

                    // Never released: without a deadline this request would hold the shutdown open until a kill.
                    fetch(`${origin}/__fixture/slow?hold=${encodeURIComponent(hold.url)}`).catch(() => undefined);
                    await hold.arrived;
                    run.child.kill("SIGTERM");

                    await expect(run.exited).resolves.toBe(1);
                    expect(run.stderr()).toMatch(/drain deadline passed with 1 response\(s\) unfinished: GET \/__fixture\/slow/u);
                } finally {
                    run.child.kill("SIGKILL");
                    await hold.close();
                }
            },
            SERVER_TEST_TIMEOUT,
        );

        it(
            "exits non-zero and says where it stopped when the shutdown stalls on work nothing will settle",
            async () => {
                expect.assertions(2);

                // Fault injection from outside the product: the HTTP server's close never calls back, so the shutdown waits on
                // a promise with no I/O behind it and Node ends the process once the event loop runs empty.
                const preload = join(workdir, "stalled-close.mjs");

                writeFileSync(
                    preload,
                    `import { Server } from "node:http";\nconst close = Server.prototype.close;\nServer.prototype.close = function () {\n    close.call(this);\n    return this;\n};\n`,
                    "utf8",
                );

                const run = startServer(artifact, dataDirectory(), RUN_ENV, ["--import", preload]);

                await run.listening;
                run.child.kill("SIGTERM");

                await expect(run.exited).resolves.toBe(1);
                expect(run.stderr()).toContain("lunora: the process exited before the shutdown finished, while closing the HTTP server");
            },
            SERVER_TEST_TIMEOUT,
        );

        it(
            "waits at SIGTERM for background work that a running waitUntil registered",
            async () => {
                expect.assertions(2);

                const hold = await holdServer();
                const run = startServer(artifact, dataDirectory());
                const marker = join(workdir, `nested-${String(runs)}`);

                try {
                    const origin = await run.listening;

                    await fetch(`${origin}/__fixture/nested?hold=${encodeURIComponent(hold.url)}&marker=${encodeURIComponent(marker)}`);
                    await hold.arrived;
                    run.child.kill("SIGTERM");
                    await run.waitForStdout("lunora: shutting down");
                    hold.release("nested work finished");

                    await expect(run.exited).resolves.toBe(0);
                    expect(readFileSync(marker, "utf8")).toBe("nested work finished");
                } finally {
                    run.child.kill("SIGKILL");
                    await hold.close();
                }
            },
            SERVER_TEST_TIMEOUT,
        );
    });

    describe("deploy-time checks", () => {
        let workdir: string;

        beforeEach(() => {
            workdir = newWorkdir();
        });

        afterEach(() => {
            rmSync(workdir, { force: true, recursive: true });
        });

        it.each<[string, Partial<DeployCommandOptions>]>([
            ["--migrate", { migrate: true }],
            ["--migrate-url", { migrateUrl: "https://app.example" }],
            ["--migrate-token", { migrateToken: "token" }],
            ["--migrate-yes", { migrateYes: true }],
            ["--migrate-allow-destructive", { migrateAllowDestructive: true }],
            ["--prebuilt", { skipCodegen: true }],
        ])("refuses %s before writing anything", async (flag, options) => {
            expect.assertions(3);

            writeFixture(workdir);

            const refused = await deploy(workdir, options);

            expect(refused).toMatchObject({ code: 2, error: expect.stringContaining(`${flag} does not apply to --target node`) });
            expect(existsSync(join(workdir, NODE_DEPLOY_DIRECTORY))).toBe(false);
            expect(existsSync(join(workdir, "lunora", "_generated"))).toBe(false);
        });

        it("refuses --image for a target that does not deploy as a container, instead of deploying it", async () => {
            expect.assertions(1);

            writeFixture(workdir);

            await expect(deploy(workdir, { image: "my-app", target: "cloudflare" })).resolves.toMatchObject({
                code: 2,
                error: expect.stringContaining("--image builds the container"),
            });
        });

        it.each<[string, Record<string, unknown>, (root: string) => void]>([
            ["a virtual entry composed by @lunora/vite", { main: "virtual:lunora/worker" }, () => {}],
            [
                "a framework adapter's output that src/worker.ts wraps",
                { main: ".svelte-kit/cloudflare/_worker.js" },
                (root) => {
                    mkdirSync(join(root, ".svelte-kit", "cloudflare"), { recursive: true });
                    writeFileSync(join(root, ".svelte-kit", "cloudflare", "_worker.js"), "export default {};\n", "utf8");
                },
            ],
        ])("refuses %s with a clear error before codegen", async (_shape, wrangler, setup) => {
            expect.assertions(3);

            writeFixture(workdir, { wrangler });
            setup(workdir);

            const refused = await deploy(workdir);

            expect(refused).toMatchObject({ code: 2, error: expect.stringContaining("does not run framework builds") });
            expect(existsSync(join(workdir, "lunora", "_generated"))).toBe(false);
            expect(existsSync(join(workdir, NODE_DEPLOY_DIRECTORY))).toBe(false);
        });

        it("refuses an entry that exports no Durable Object class, such as a framework adapter with no composed wrapper", async () => {
            expect.assertions(2);

            writeFixture(workdir, { wrangler: { main: "adapter/_worker.js" } });
            // No composed src/worker.ts: the adapter is the whole entry, so only its missing exports can give it away.
            rmSync(join(workdir, "src", "worker.ts"));
            mkdirSync(join(workdir, "adapter"));
            writeFileSync(join(workdir, "adapter", "_worker.js"), `export default { fetch: () => new Response("adapter") };\n`, "utf8");

            await expect(deploy(workdir)).resolves.toMatchObject({
                code: 1,
                error: expect.stringContaining("adapter/_worker.js), and it does not export ShardDO"),
            });
            expect(existsSync(join(workdir, NODE_DEPLOY_DIRECTORY, "server.mjs"))).toBe(false);
        });

        it.each<[string, unknown]>([
            ["a string", { required: "API_KEY" }],
            ["a number", { required: 42 }],
            ["a list with a non-string entry", { required: ["API_KEY", 3] }],
            ["a list with an empty entry", { required: ["API_KEY", ""] }],
            ["a bare string in place of the object", "API_KEY"],
            ["misspelled as require", { require: ["API_KEY"] }],
            ["missing from the secrets object", {}],
            ["a name with a dash", { required: ["API-KEY"] }],
            ["a name starting with a digit", { required: ["1KEY"] }],
        ])("refuses secrets.required when it is %s, instead of dropping the names", async (_shape, secrets) => {
            expect.assertions(2);

            writeFixture(workdir, { wrangler: { secrets } });

            await expect(deploy(workdir)).resolves.toMatchObject({
                code: 2,
                error: expect.stringContaining('in wrangler.jsonc: secrets must be { "required": [...] }'),
            });
            expect(existsSync(join(workdir, "lunora", "_generated"))).toBe(false);
        });

        it.each(["..", "a/b"])("refuses the Durable Object binding name %j, which would put shard files outside the data volume", async (name) => {
            expect.assertions(2);

            writeFixture(workdir, { wrangler: { durable_objects: { bindings: [{ class_name: "ShardDO", name }] } } });

            await expect(deploy(workdir)).resolves.toMatchObject({
                code: 2,
                error: expect.stringContaining(`the binding ${JSON.stringify(name)} in wrangler.jsonc is not a valid binding name`),
            });
            expect(existsSync(join(workdir, "lunora", "_generated"))).toBe(false);
        });

        it("refuses an app that imports an optional ws add-on the project does not install, naming it", async () => {
            expect.assertions(2);

            writeFixture(workdir);
            writeFileSync(join(workdir, "src", "worker.ts"), `import "bufferutil";\n${readFileSync(join(workdir, "src", "worker.ts"), "utf8")}`, "utf8");

            await expect(deploy(workdir)).resolves.toMatchObject({
                code: 1,
                error: expect.stringContaining("it imports bufferutil, which this project does not install"),
            });
            expect(existsSync(join(workdir, NODE_DEPLOY_DIRECTORY, "server.mjs"))).toBe(false);
        });

        it("serves an app that imports ws, whose optional add-ons it does not install", async () => {
            expect.assertions(2);

            writeFixture(workdir, { extraModules: { ws: WS_PACKAGE } });
            writeFileSync(
                join(workdir, "src", "worker.ts"),
                `import { WebSocket } from "ws";\n\nexport const webSocketClass = WebSocket.name;\n\n${readFileSync(join(workdir, "src", "worker.ts"), "utf8")}`,
                "utf8",
            );

            await expect(deploy(workdir)).resolves.toMatchObject({ code: 0 });

            const artifact = join(workdir, NODE_DEPLOY_DIRECTORY);

            mkdirSync(join(artifact, "node_modules"));
            symlinkSync(BETTER_SQLITE3, join(artifact, "node_modules", "better-sqlite3"), "dir");

            const run = startServer(artifact, join(workdir, "data"));

            try {
                const origin = await run.listening;

                await expect(callFunction(origin, "notes:greeting")).resolves.toStrictEqual({ result: "from the container" });
            } finally {
                run.child.kill("SIGTERM");
                await run.exited;
            }
        });

        it("writes a reproducible build context: a lockfile npm ci installs from, and the same bytes on every deploy", async () => {
            expect.assertions(5);

            writeFixture(workdir);

            const artifact = join(workdir, NODE_DEPLOY_DIRECTORY);
            const digests = (): Record<string, string> =>
                Object.fromEntries(
                    readdirSync(artifact)
                        .toSorted((left, right) => left.localeCompare(right))
                        .map((file) => [
                            file,
                            createHash("sha256")
                                .update(readFileSync(join(artifact, file)))
                                .digest("hex"),
                        ]),
                );
            const calls: SpawnDescriptor[] = [];

            await expect(deploy(workdir, { spawner: fakeNpm(calls) })).resolves.toMatchObject({ code: 0 });

            const first = digests();

            await deploy(workdir);

            expect(digests()).toStrictEqual(first);
            // The lockfile is resolved in the build context itself, from the manifest written there.
            expect(calls).toContainEqual(
                expect.objectContaining({ args: expect.arrayContaining(["install", "--package-lock-only"]), command: "npm", cwd: artifact }),
            );

            const buildFile = readFileSync(join(artifact, "Dockerfile"), "utf8");

            expect(buildFile).toContain("COPY package.json package-lock.json ./");
            expect(buildFile).toContain("RUN npm ci --omit=dev");
        });

        it("refuses to write a build context it cannot pin, when npm cannot write the lockfile", async () => {
            expect.assertions(1);

            writeFixture(workdir);

            await expect(
                deploy(workdir, {
                    spawner: async () => {
                        return { code: 1, stderr: "npm error network request failed" };
                    },
                }),
            ).resolves.toMatchObject({
                code: 1,
                error: expect.stringContaining("could not write one (exit 1: npm error network request failed)"),
            });
        });

        it.each<[string, Record<string, unknown>, string]>([
            ["a Hyperdrive entry with no binding", { hyperdrive: [{ id: "abc" }] }, "hyperdrive[0] in wrangler.jsonc has none"],
            ["a Hyperdrive binding that is not a string", { hyperdrive: [{ binding: 3, id: "abc" }] }, "hyperdrive[0] in wrangler.jsonc has 3"],
            [
                "a Hyperdrive section that is not a list",
                { hyperdrive: "HYPERDRIVE" },
                'reads hyperdrive in wrangler.jsonc as a list of bindings, and it is "HYPERDRIVE"',
            ],
            [
                "a Secrets Store entry with no binding",
                {
                    secrets_store_secrets: [
                        { binding: "STRIPE_KEY", secret_name: "stripe", store_id: "s" },
                        { secret_name: "other", store_id: "s" },
                    ],
                },
                "secrets_store_secrets[1] in wrangler.jsonc has none",
            ],
            [
                "a Durable Object entry with no class",
                { durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }, { name: "OTHER" }] } },
                "durable_objects.bindings[1] in wrangler.jsonc lacks one",
            ],
            [
                "a Durable Object entry that is not an object",
                { durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }, "OTHER"] } },
                "durable_objects.bindings[1] in wrangler.jsonc lacks one",
            ],
            ["vars that are not an object", { vars: "LIMIT=3" }, 'reads vars in wrangler.jsonc as an object of names and values, and it is "LIMIT=3"'],
            [
                "a var whose name is not an environment variable",
                { vars: { "API-URL": "x" } },
                'vars in wrangler.jsonc has "API-URL", which is not an environment variable name',
            ],
        ])("refuses %s, naming where, instead of dropping it", async (_shape, wrangler, where) => {
            expect.assertions(2);

            writeFixture(workdir, { wrangler });

            await expect(deploy(workdir)).resolves.toMatchObject({ code: 2, error: expect.stringContaining(where) });
            expect(existsSync(join(workdir, "lunora", "_generated"))).toBe(false);
        });

        it("delivers crons to the shard binding by its class, whatever it is named and wherever it is listed", async () => {
            expect.assertions(2);

            writeFixture(workdir, {
                wrangler: {
                    durable_objects: {
                        bindings: [
                            { class_name: "Chat", name: "CHAT" },
                            { class_name: "ShardDO", name: "MAIN" },
                        ],
                    },
                },
            });
            writeFileSync(
                join(workdir, "src", "worker.ts"),
                `${readFileSync(join(workdir, "src", "worker.ts"), "utf8")}\nexport class Chat {\n    fetch(): Response {\n        return new Response("chat");\n    }\n}\n`,
                "utf8",
            );

            await expect(deploy(workdir)).resolves.toMatchObject({ code: 0 });
            // The platform's registry, where crons and scheduled jobs land, is the ShardDO binding's, not the first one listed.
            expect(readFileSync(join(workdir, NODE_DEPLOY_DIRECTORY, "server.mjs"), "utf8")).toContain('PRIMARY_BINDING = "MAIN"');
        });

        it("names the wrangler cron triggers only a scheduled() handler would serve, which never fire in the container", async () => {
            expect.assertions(2);

            writeFixture(workdir, { wrangler: { triggers: { crons: ["0 3 * * *"] } } });

            const { logger, warnings } = recordingLogger();

            await expect(runDeployCommand({ cwd: workdir, interactive: false, logger, spawner: fakeNpm(), target: "node" })).resolves.toMatchObject({
                code: 0,
            });
            expect(warnings.join("\n")).toContain(
                "never calls the worker's scheduled() handler, so these wrangler triggers.crons will not fire (a createWorker backupCron or crons job on them does not run): 0 3 * * *",
            );
        });

        it("names a createWorker backupCron trigger, which codegen lists but only scheduled() would run", async () => {
            expect.assertions(2);

            writeFixture(workdir, { wrangler: { triggers: { crons: ["0 4 * * *"] } } });

            const worker = join(workdir, "src", "worker.ts");

            writeFileSync(
                worker,
                readFileSync(worker, "utf8").replace("createWorker({ shardDO: env.SHARD })", 'createWorker({ backupCron: "0 4 * * *", shardDO: env.SHARD })'),
                "utf8",
            );

            const { logger, warnings } = recordingLogger();

            await expect(runDeployCommand({ cwd: workdir, interactive: false, logger, spawner: fakeNpm(), target: "node" })).resolves.toMatchObject({
                code: 0,
            });
            expect(warnings.join("\n")).toContain("will not fire (a createWorker backupCron or crons job on them does not run): 0 4 * * *");
        });

        it("gives an app file whose name contains platform-node the ordinary missing-export message, not the upgrade advice", async () => {
            expect.assertions(2);

            writeFixture(workdir, { wrangler: { main: "src/platform-node-worker.ts" } });
            // The app's own entry, which happens to be named after the package and exports no ShardDO.
            rmSync(join(workdir, "src", "worker.ts"));
            writeFileSync(join(workdir, "src", "platform-node-worker.ts"), `export default { fetch: () => new Response("app") };\n`, "utf8");

            const result = await deploy(workdir);

            expect(result).toMatchObject({ code: 1, error: expect.stringContaining("(src/platform-node-worker.ts), and it does not export ShardDO") });
            expect(result.error).not.toContain("predates");
        });

        it("refuses a project whose @lunora/platform-node predates deadline-bounded drains", async () => {
            expect.assertions(1);

            // A stand-in for an older release: the same exports, minus the bounded-drain one this deploy needs.
            const oldPlatform = join(workdir, "old-platform-node");

            mkdirSync(oldPlatform);
            writeFileSync(
                join(oldPlatform, "package.json"),
                JSON.stringify({
                    exports: { ".": { import: "./index.mjs" }, "./package.json": "./package.json" },
                    name: "@lunora/platform-node",
                    type: "module",
                    version: "1.0.0-alpha.200",
                }),
                "utf8",
            );
            writeFileSync(
                join(oldPlatform, "index.mjs"),
                [
                    "bindShardSockets",
                    "createNodeHttpServer",
                    "createNodeHyperdrive",
                    "createNodePlatform",
                    "createNodeSecretBindings",
                    "createNodeShardNamespace",
                    "createNodeShardRegistry",
                    "createNodeShardState",
                ]
                    .map((name) => `export const ${name} = () => {};`)
                    .join("\n"),
                "utf8",
            );
            writeFixture(workdir, { extraModules: { "@lunora/platform-node": oldPlatform } });

            await expect(deploy(workdir)).resolves.toMatchObject({
                code: 1,
                error: expect.stringContaining("this project installs 1.0.0-alpha.200, which predates them, so every container shutdown would fail"),
            });
        });

        it("refuses a name that is both a secrets.required entry and a secrets_store binding, which would replace the plain secret", async () => {
            expect.assertions(2);

            writeFixture(workdir, {
                wrangler: {
                    secrets: { required: ["SESSION_SECRET", "STRIPE_KEY"] },
                    secrets_store_secrets: [{ binding: "STRIPE_KEY", secret_name: "stripe", store_id: "store" }],
                },
            });

            await expect(deploy(workdir)).resolves.toMatchObject({
                code: 2,
                error: expect.stringContaining("STRIPE_KEY in wrangler.jsonc is both: the store binding would silently replace the plain secret"),
            });
            expect(existsSync(join(workdir, "lunora", "_generated"))).toBe(false);
        });

        it("refuses a secrets_store binding with the reserved LUNORA_ prefix, which could never start", async () => {
            expect.assertions(1);

            writeFixture(workdir, { wrangler: { secrets_store_secrets: [{ binding: "LUNORA_SIGNING_KEY", secret_name: "s", store_id: "x" }] } });

            await expect(deploy(workdir)).resolves.toMatchObject({ code: 2, error: expect.stringContaining("LUNORA_SIGNING_KEY") });
        });

        it("names every declared binding the server leaves unbound, including an external Durable Object", async () => {
            expect.assertions(2);

            writeFixture(workdir, {
                wrangler: {
                    durable_objects: {
                        bindings: [
                            { class_name: "ShardDO", name: "SHARD" },
                            { class_name: "Billing", name: "BILLING", script_name: "billing-worker" },
                        ],
                    },
                    flagship: [{ app_id: "app", binding: "FLAGS_SERVICE" }],
                    version_metadata: { binding: "CF_VERSION_METADATA" },
                },
            });

            const { logger, warnings } = recordingLogger();
            const deployed = await runDeployCommand({ cwd: workdir, interactive: false, logger, spawner: fakeNpm(), target: "node" });

            expect(deployed.code).toBe(0);
            expect(warnings.join("\n")).toMatch(/not bound.*flagship.*version_metadata.*durable_objects\.BILLING/u);
        });

        it("generates into the configured schemaDir, where the bundle reads it", async () => {
            expect.assertions(2);

            writeFixture(workdir, { schemaDir: "backend" });

            await expect(deploy(workdir)).resolves.toMatchObject({ code: 0 });
            expect(existsSync(join(workdir, "backend", "_generated", "crons.ts"))).toBe(true);
        });

        // A real image build pulls the base image and compiles better-sqlite3: only where an engine runs, never in CI.
        it.runIf(process.env.CI === undefined && dockerAvailable())(
            "builds the image with --image when Docker answers",
            async () => {
                expect.assertions(1);

                writeFixture(workdir);

                const image = `lunora-node-container-test:${String(process.pid)}`;

                try {
                    // The real npm and the real Docker, so the lockfile the image is built from is one npm resolved.
                    await expect(deploy(workdir, { image, spawner: defaultSpawner })).resolves.toMatchObject({ code: 0, container: { image } });
                } finally {
                    // eslint-disable-next-line sonarjs/no-os-command-from-path -- the engine resolves from PATH; fixed args, no shell
                    spawnSync("docker", ["image", "rm", "-f", image], { stdio: "ignore" });
                }
            },
            600_000,
        );
    });
});
