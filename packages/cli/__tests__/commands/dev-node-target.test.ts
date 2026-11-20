import type { FSWatcher } from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { checkNodeAppHost, createNodeAppHost, createNodeHttpServer, createNodeHyperdrive, createNodeSecretBindings } from "@lunora/platform-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { provisionBindings } from "../../src/commands/deploy/handler";
import { runDevCommand } from "../../src/commands/dev/handler";
import { planNodeDevServer, startNodeDevWorker } from "../../src/commands/dev/node-dev-server";
import { startContainerLogStreaming } from "../../src/commands/dev/supervise";
import type { NodeDevWorker, PlatformNode } from "../../src/commands/dev/types";
import { findAvailablePort } from "../../src/util/free-port";
import type { Logger } from "../../src/util/logger";

// Pass-through spies: what Node dev must not call (binding provisioning under a refused --remote, container log tailing).
vi.mock(import("../../src/commands/deploy/handler"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, provisionBindings: vi.fn<typeof actual.provisionBindings>(actual.provisionBindings) };
});
vi.mock(import("../../src/commands/dev/supervise"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, startContainerLogStreaming: vi.fn<typeof actual.startContainerLogStreaming>(actual.startContainerLogStreaming) };
});

// A pass-through spy, so a test can reach the watcher a call returned and make it fail.
vi.mock(import("node:fs"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, watch: vi.fn<typeof actual.watch>(actual.watch) as unknown as typeof actual.watch };
});

/** The project's real `@lunora/platform-node`, which a test wraps to inject a failure. */
const realPlatform = { checkNodeAppHost, createNodeAppHost, createNodeHttpServer, createNodeHyperdrive, createNodeSecretBindings } as unknown as PlatformNode;

/** This package's node_modules: the fixture links it so `@lunora/*` resolve to the workspace builds. */
const PACKAGE_NODE_MODULES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules");

/**
 * The fixture's shard reports each function call it answers here. The app runs in this process, so a global is how a test
 * observes a delivery that has no HTTP response of its own (a cron tick).
 */
const SHARD_CALL_HOOK = "__lunoraNodeDevShardCall";

type ShardCallHook = (functionPath: string, status: number) => void;

const notesSource = (greeting: string): string => `import { internalMutation, mutation, query, v } from "./_generated/server.js";

export const greeting = query.query(async (): Promise<string> => ${JSON.stringify(greeting)});

export const add = mutation.input({ text: v.string() }).mutation(async ({ args, ctx }) => ctx.db.insert("notes", { text: args.text }));

export const tick = internalMutation.mutation(async ({ ctx }) => ctx.db.insert("notes", { text: "tick" }));
`;

const writeFixture = (root: string, wrangler: Record<string, unknown> = {}): void => {
    mkdirSync(join(root, "lunora"));
    mkdirSync(join(root, "src"));
    symlinkSync(PACKAGE_NODE_MODULES, join(root, "node_modules"), "dir");
    writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ dependencies: { "@lunora/scheduler": "*" }, name: "node-target-app", private: true, type: "module" }),
        "utf8",
    );
    writeFileSync(join(root, "lunora.config.ts"), `export default { target: "node" };\n`, "utf8");
    writeFileSync(
        join(root, "wrangler.jsonc"),
        JSON.stringify({
            compatibility_date: "2026-10-01",
            durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
            main: "src/worker.ts",
            migrations: [{ new_sqlite_classes: ["ShardDO"], tag: "v1" }],
            name: "node-target-app",
            ...wrangler,
        }),
        "utf8",
    );
    writeFileSync(
        join(root, "lunora", "schema.ts"),
        `import { defineSchema, defineTable, v } from "@lunora/server";\n\nexport default defineSchema({ notes: defineTable({ text: v.string() }) });\n`,
        "utf8",
    );
    writeFileSync(join(root, "lunora", "notes.ts"), notesSource("v1"), "utf8");
    writeFileSync(
        join(root, "src", "worker.ts"),
        `import { createWorker } from "@lunora/runtime";

import { createShardDO } from "../lunora/_generated/shard.js";

const Shard = createShardDO();

export class ShardDO extends Shard {
    public override async fetch(request: Request): Promise<Response> {
        const hook = (globalThis as Record<string, unknown>)[${JSON.stringify(SHARD_CALL_HOOK)}] as undefined | ((path: string, status: number) => void);
        const call = hook !== undefined && new URL(request.url).pathname === "/rpc" ? ((await request.clone().json()) as { functionPath: string }) : undefined;
        const response = await super.fetch(request);

        if (call !== undefined) {
            hook?.(call.functionPath, response.status);
        }

        return response;
    }
}

interface Env {
    API_KEY?: { get: () => Promise<string> };
    HYPERDRIVE?: { host: string; port: number };
    SHARD: never;
    STAGE?: string;
}

let worker: ReturnType<typeof createWorker> | undefined;

export default {
    async fetch(request: Request, env: Env, ctx: never): Promise<Response> {
        if (new URL(request.url).pathname === "/__env") {
            return Response.json({
                hyperdrive: env.HYPERDRIVE && { host: env.HYPERDRIVE.host, port: env.HYPERDRIVE.port },
                secret: await env.API_KEY?.get(),
                stage: env.STAGE,
            });
        }

        worker ??= createWorker({ shardDO: env.SHARD });

        return worker.fetch(request, env, ctx);
    },
};
`,
        "utf8",
    );
};

/** A second entry over the fixture's worker that answers `/__which` with `name`, so a test can tell which entry is served. */
const writeAlternateEntry = (root: string, file: string, name: string): void => {
    writeFileSync(
        join(root, "src", file),
        `import worker from "./worker";

export { ShardDO } from "./worker";

export default {
    fetch: (request: Request, env: never, ctx: never): Promise<Response> | Response =>
        new URL(request.url).pathname === "/__which" ? new Response(${JSON.stringify(name)}) : worker.fetch(request, env, ctx),
};
`,
        "utf8",
    );
};

/** Rewrite one file through `pattern`, failing when it matches nothing: a no-op write would still raise a change event. */
const editFile = (path: string, pattern: RegExp, replacement: string): void => {
    const before = readFileSync(path, "utf8");
    const after = before.replace(pattern, replacement);

    if (after === before) {
        throw new Error(`${pattern.source} matched nothing in ${path}`);
    }

    writeFileSync(path, after, "utf8");
};

/**
 * A request on a connection of its own. A reload closes the previous listener, and a pooled keep-alive socket to it can be
 * handed to the next request before the client has seen it close.
 */
const freshFetch = async (url: string): Promise<Response> => fetch(url, { headers: { connection: "close" } });

const readEnv = async (origin: string): Promise<unknown> => {
    const response = await freshFetch(`${origin}/__env`);

    return response.json();
};

const readWhich = async (origin: string): Promise<string> => {
    const response = await freshFetch(`${origin}/__which`);

    return response.text();
};

/** Whether `port` can be bound now, so nothing still holds it. */
const portIsFree = async (port: number): Promise<boolean> =>
    new Promise((resolve) => {
        const probe = createServer();

        probe.once("error", () => {
            resolve(false);
        });
        probe.listen(port, () => {
            probe.close(() => {
                resolve(true);
            });
        });
    });

/** A logger whose info and error lines can be awaited: each wait resolves on the next line containing the text, never on a timer. */
const milestoneLogger = (): { errors: string[]; logger: Logger; next: (text: string) => Promise<void>; warnings: string[] } => {
    const waiters: { resolve: () => void; text: string }[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const info = (message: string): void => {
        for (const waiter of waiters.filter((candidate) => message.includes(candidate.text))) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve();
        }
    };

    return {
        errors,
        logger: {
            error: (message: string) => {
                errors.push(message);
                info(message);
            },
            info,
            success: () => {},
            warn: (message: string) => {
                warnings.push(message);
            },
        },
        next: async (text) =>
            new Promise<void>((resolve) => {
                waiters.push({ resolve, text });
            }),
        warnings,
    };
};

const callQuery = async (origin: string, functionPath: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const response = await fetch(`${origin}/_lunora/rpc`, {
        body: JSON.stringify({ args, functionPath }),
        // Its own connection, as `freshFetch` explains; a pooled one would also leave the client's keep-alive timers running into
        // a later test's fake clock.
        headers: { connection: "close", "content-type": "application/json" },
        method: "POST",
    });

    return response.json();
};

/**
 * Start `lunora dev --target node` on `workdir` and resolve once it serves; `stop` ends it and resolves with its result.
 * `firstReload` is armed before the start, so a reload the start itself triggers is not missed.
 */
const startDev = async (workdir: string, options: { codegen?: boolean; platform?: PlatformNode; remote?: boolean; remoteFromDefault?: boolean } = {}) => {
    const port = await findAvailablePort(18_870);
    const { errors, logger, next, warnings } = milestoneLogger();
    const serving = next("node: serving");
    const firstReload = next("node: reloaded");
    let worker: NodeDevWorker | undefined;

    const run = runDevCommand({
        codegen: options.codegen,
        cwd: workdir,
        logger,
        remote: options.remote,
        remoteFromDefault: options.remoteFromDefault,
        studio: false,
        startNodeWorker: async (inputs) => {
            worker = await startNodeDevWorker({ ...inputs, platform: options.platform });

            return worker;
        },
        target: "node",
        workerPort: port,
    });

    // A run that ends before serving (a refused target, a failed load) fails here rather than at the test timeout.
    const ended = run.then((result) => {
        throw new Error(`lunora dev ended with code ${String(result.code)} before serving: ${errors.join("; ")}`);
    });

    await Promise.race([serving, ended]);

    return {
        errors,
        firstReload,
        next,
        warnings,
        origin: `http://localhost:${String(port)}`,
        stop: async () => {
            worker?.kill("SIGTERM");

            return run;
        },
    };
};

describe("lunora dev --target node", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = realpathSync(mkdtempSync(join(tmpdir(), "lunora-cli-node-dev-")));
    });

    afterEach(() => {
        vi.useRealTimers();
        Reflect.deleteProperty(globalThis, SHARD_CALL_HOOK);
        // The spy keeps every watcher it returned, and each watcher's listener holds a whole worker (its module graph included).
        vi.mocked(watch).mockClear();
        vi.mocked(provisionBindings).mockClear();
        vi.mocked(startContainerLogStreaming).mockClear();
        rmSync(workdir, { force: true, recursive: true });
    });

    it("serves a query over HTTP and picks up a changed function", async () => {
        expect.assertions(4);

        writeFixture(workdir);

        const dev = await startDev(workdir);

        try {
            await expect(callQuery(dev.origin, "notes:greeting")).resolves.toStrictEqual({ result: "v1" });
            // A write lands in the shard's SQLite, so the request reached a real ShardDO on the Node host.
            await expect(callQuery(dev.origin, "notes:add", { text: "hello" })).resolves.toStrictEqual({ result: expect.any(String) });

            const reloaded = dev.next("node: reloaded");

            writeFileSync(join(workdir, "lunora", "notes.ts"), notesSource("v2"), "utf8");
            await reloaded;

            await expect(callQuery(dev.origin, "notes:greeting")).resolves.toStrictEqual({ result: "v2" });
        } finally {
            await expect(dev.stop()).resolves.toMatchObject({ code: 0 });
        }
    });

    it("fires a cron declared in lunora/crons.ts on the injected clock", async () => {
        expect.assertions(2);

        writeFixture(workdir);
        writeFileSync(
            join(workdir, "lunora", "crons.ts"),
            `import { cronJobs } from "@lunora/server";

import { internal } from "./_generated/internal.js";

const crons = cronJobs();

crons.cron("tick", "* * * * *", internal.notes.tick, {});

export default crons;
`,
            "utf8",
        );

        // Real time still passes, so the start-up I/O completes; the minute the cron waits for is the injected part.
        vi.useFakeTimers({ now: new Date("2026-11-01T12:00:30Z"), shouldAdvanceTime: true, toFake: ["Date", "setTimeout", "clearTimeout"] });

        let ticked: (status: number) => void = () => {};
        const tick = new Promise<number>((_resolve) => {
            ticked = _resolve;
        });
        const hook: ShardCallHook = (functionPath, status) => {
            if (functionPath === "notes:tick") {
                ticked(status);
            }
        };

        Reflect.set(globalThis, SHARD_CALL_HOOK, hook);

        const dev = await startDev(workdir);

        try {
            await vi.advanceTimersByTimeAsync(60 * 1000);

            // The delivery is the milestone: the scheduler's call reached the shard, and the function committed.
            await expect(tick).resolves.toBe(200);
        } finally {
            await expect(dev.stop()).resolves.toMatchObject({ code: 0 });
        }
    });

    it("binds a declared secret from .dev.vars and Hyperdrive from DATABASE_URL", async () => {
        expect.assertions(2);

        writeFixture(workdir, {
            hyperdrive: [{ binding: "HYPERDRIVE", id: "local" }],
            secrets_store_secrets: [{ binding: "API_KEY", secret_name: "api-key", store_id: "local" }],
        });
        // eslint-disable-next-line no-secrets/no-secrets -- a fixture dev-vars file with a placeholder secret and a passwordless local URL
        writeFileSync(join(workdir, ".dev.vars"), "API_KEY=from-dev-vars\nDATABASE_URL=postgres://app@db.local:5433/app\n", "utf8");

        const dev = await startDev(workdir);

        try {
            const response = await fetch(`${dev.origin}/__env`);

            await expect(response.json()).resolves.toStrictEqual({ hyperdrive: { host: "db.local", port: 5433 }, secret: "from-dev-vars" });
        } finally {
            await expect(dev.stop()).resolves.toMatchObject({ code: 0 });
        }
    });

    it("reloads on a file under lunora/ when the codegen watcher is off", async () => {
        expect.assertions(2);

        writeFixture(workdir);

        // A first session generates `_generated/*`; the second runs without codegen over it.
        const generating = await startDev(workdir);

        await generating.stop();

        const dev = await startDev(workdir, { codegen: false });

        try {
            const reloaded = dev.next("node: reloaded");

            writeFileSync(join(workdir, "lunora", "notes.ts"), notesSource("v2"), "utf8");
            await reloaded;

            await expect(callQuery(dev.origin, "notes:greeting")).resolves.toStrictEqual({ result: "v2" });
        } finally {
            await expect(dev.stop()).resolves.toMatchObject({ code: 0 });
        }
    });

    it("reloads when a file the load read changed before its watcher started", async () => {
        expect.assertions(1);

        writeFixture(workdir);

        // A modification time after the load began stands in for an edit landing between the read and the watch.
        const later = new Date(Date.now() + 60_000);

        utimesSync(join(workdir, "src", "worker.ts"), later, later);

        const dev = await startDev(workdir);

        try {
            await dev.firstReload;

            await expect(callQuery(dev.origin, "notes:greeting")).resolves.toStrictEqual({ result: "v1" });
        } finally {
            await dev.stop();
        }
    });

    it("leaves no reload armed when the first start fails after its load saw a changed file", async () => {
        expect.assertions(2);

        writeFixture(workdir);

        // A first session generates `_generated/*`, so the start below fails at the listener rather than at the load.
        const generating = await startDev(workdir);

        await generating.stop();

        // A modification time after the load began: the load marks a reload, which a failed start must not leave behind.
        const later = new Date(Date.now() + 60_000);

        utimesSync(join(workdir, "src", "worker.ts"), later, later);
        // Not advanced: a reload timer the start armed stays pending, where the count below sees it.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        const { logger } = milestoneLogger();
        const platform: PlatformNode = {
            ...realPlatform,
            createNodeHttpServer: async () => {
                throw new Error("listen EADDRINUSE");
            },
        };

        await expect(
            startNodeDevWorker({ codegenWatch: false, logger, platform, port: await findAvailablePort(18_870), projectRoot: workdir }),
        ).rejects.toThrow(/EADDRINUSE/u);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps the session up when the reloaded listener cannot bind, and serves on the next change", async () => {
        // `hasAssertions`: the error check runs inside `vi.waitFor`, which retries it an indeterminate number of times.
        expect.hasAssertions();

        writeFixture(workdir);

        let listeners = 0;
        const platform: PlatformNode = {
            ...realPlatform,
            createNodeHttpServer: async (options) => {
                listeners += 1;

                // The second listener is the first reload's.
                if (listeners === 2) {
                    throw new Error("listen EADDRINUSE");
                }

                return realPlatform.createNodeHttpServer(options);
            },
        };
        const dev = await startDev(workdir, { platform });

        try {
            const reloaded = dev.next("node: reloaded");

            writeFileSync(join(workdir, "lunora", "notes.ts"), notesSource("v2"), "utf8");
            // Logged as an error, which the milestone logger does not resolve on.
            await vi.waitFor(() => {
                expect(dev.errors.join(" ")).toContain("Nothing is serving until a reload succeeds");
            });

            writeFileSync(join(workdir, "lunora", "notes.ts"), notesSource("v3"), "utf8");
            await reloaded;

            await expect(callQuery(dev.origin, "notes:greeting")).resolves.toStrictEqual({ result: "v3" });
        } finally {
            await expect(dev.stop()).resolves.toMatchObject({ code: 0 });
        }
    });

    it("closes the previous host and keeps reloading when its listener fails to close", async () => {
        expect.assertions(3);

        writeFixture(workdir);

        const hostCloses = vi.fn<() => void>();
        let listeners = 0;
        const platform: PlatformNode = {
            ...realPlatform,
            createNodeAppHost: (options) => {
                const host = realPlatform.createNodeAppHost(options);

                return {
                    ...host,
                    close: async (closeOptions) => {
                        hostCloses();

                        return host.close(closeOptions);
                    },
                };
            },
            createNodeHttpServer: async (options) => {
                listeners += 1;

                const server = await realPlatform.createNodeHttpServer(options);

                // The first listener closes, then reports a failure, as a close that errors after releasing the port would.
                return listeners === 1
                    ? {
                          close: async () => {
                              await server.close();

                              throw new Error("close failed");
                          },
                          drain: async (drainOptions) => server.drain(drainOptions),
                      }
                    : server;
            },
        };
        const dev = await startDev(workdir, { platform });

        try {
            const reloaded = dev.next("node: reloaded");

            writeFileSync(join(workdir, "lunora", "notes.ts"), notesSource("v2"), "utf8");
            await reloaded;

            expect(hostCloses).toHaveBeenCalledTimes(1);
            await expect(callQuery(dev.origin, "notes:greeting")).resolves.toStrictEqual({ result: "v2" });
        } finally {
            await expect(dev.stop()).resolves.toMatchObject({ code: 0 });
        }
    });

    it("refuses a @lunora/platform-node without createNodeAppHost, naming the upgrade", async () => {
        expect.assertions(1);

        writeFixture(workdir);

        const { logger } = milestoneLogger();
        const older = { ...realPlatform, createNodeAppHost: undefined };

        await expect(
            startNodeDevWorker({
                codegenWatch: false,
                logger,
                platform: older as unknown as PlatformNode,
                port: await findAvailablePort(18_870),
                projectRoot: workdir,
            }),
        ).rejects.toThrow(/createNodeAppHost and checkNodeAppHost \(1\.0\.0-alpha\.222 or later\)/u);
    });

    it("serves the CLOUDFLARE_ENV environment's entry, bindings, vars and .dev.vars.<env>", async () => {
        expect.assertions(2);

        writeFixture(workdir, {
            env: {
                staging: {
                    // Bindings and vars are not inherited; `main` is, and this environment overrides it.
                    durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                    main: "src/staging.ts",
                    secrets_store_secrets: [{ binding: "API_KEY", secret_name: "api-key", store_id: "local" }],
                    vars: { STAGE: "staging" },
                },
            },
            vars: { STAGE: "top" },
        });
        writeAlternateEntry(workdir, "staging.ts", "staging");
        writeFileSync(join(workdir, ".dev.vars"), "API_KEY=from-default\n", "utf8");
        writeFileSync(join(workdir, ".dev.vars.staging"), "API_KEY=from-staging\n", "utf8");
        vi.stubEnv("CLOUDFLARE_ENV", "staging");

        const dev = await startDev(workdir);

        try {
            await expect(readEnv(dev.origin)).resolves.toStrictEqual({ secret: "from-staging", stage: "staging" });
            await expect(readWhich(dev.origin)).resolves.toBe("staging");
        } finally {
            await dev.stop();
            vi.unstubAllEnvs();
        }
    });

    it("reloads when .dev.vars or wrangler.jsonc changes", async () => {
        expect.assertions(3);

        writeFixture(workdir, {
            secrets_store_secrets: [{ binding: "API_KEY", secret_name: "api-key", store_id: "local" }],
            vars: { STAGE: "one" },
        });
        writeFileSync(join(workdir, ".dev.vars"), "API_KEY=first\n", "utf8");

        const dev = await startDev(workdir);

        try {
            await expect(readEnv(dev.origin)).resolves.toStrictEqual({ secret: "first", stage: "one" });

            const afterDevVariables = dev.next("node: reloaded");
            // The start may have added a generated secret to the file; only the one line changes.
            editFile(join(workdir, ".dev.vars"), /API_KEY=first/u, "API_KEY=second");
            await afterDevVariables;

            await expect(readEnv(dev.origin)).resolves.toStrictEqual({ secret: "second", stage: "one" });

            const afterConfig = dev.next("node: reloaded");
            // The start may have reformatted the file, so the match allows any spacing.
            editFile(join(workdir, "wrangler.jsonc"), /"STAGE":\s*"one"/u, `"STAGE": "two"`);
            await afterConfig;

            await expect(readEnv(dev.origin)).resolves.toStrictEqual({ secret: "second", stage: "two" });
        } finally {
            await dev.stop();
        }
    });

    it("loads the entry `main` names now, not the one it named at startup", async () => {
        expect.assertions(1);

        writeFixture(workdir);
        writeAlternateEntry(workdir, "other.ts", "other");

        const dev = await startDev(workdir);

        try {
            const reloaded = dev.next("node: reloaded");
            editFile(join(workdir, "wrangler.jsonc"), /"main":\s*"src\/worker\.ts"/u, `"main": "src/other.ts"`);
            // A function edit reloads on its own, so the check holds whichever change the reload follows.
            writeFileSync(join(workdir, "lunora", "notes.ts"), notesSource("v2"), "utf8");
            await reloaded;

            await expect(readWhich(dev.origin)).resolves.toBe("other");
        } finally {
            await dev.stop();
        }
    });

    describe("started directly, over a generated project", () => {
        /** Generate `_generated/*` with a normal session, then start the worker alone with `inputs`. */
        const startWorker = async (inputs: Partial<Parameters<typeof startNodeDevWorker>[0]> = {}) => {
            const generating = await startDev(workdir);

            await generating.stop();

            const { errors, logger, next, warnings } = milestoneLogger();
            const port = await findAvailablePort(18_870);
            const worker = await startNodeDevWorker({ codegenWatch: false, logger, port, projectRoot: workdir, ...inputs });

            return {
                errors,
                next,
                warnings,
                origin: `http://localhost:${String(port)}`,
                port,
                stop: async () => {
                    worker.kill("SIGTERM");

                    return worker.exited;
                },
                worker,
            };
        };

        /** Start the worker alone over a fresh fixture with `wrangler` merged into its config, then clear the fixture away. */
        const startOverConfig = async (wrangler: Record<string, unknown>): Promise<unknown> => {
            writeFixture(workdir, wrangler);

            try {
                return await startNodeDevWorker({
                    codegenWatch: false,
                    logger: milestoneLogger().logger,
                    port: await findAvailablePort(18_870),
                    projectRoot: workdir,
                });
            } finally {
                rmSync(workdir, { force: true, recursive: true });
                mkdirSync(workdir);
            }
        };

        it("waits out a busy codegen run before the first load", async () => {
            expect.assertions(1);

            writeFixture(workdir);

            let released = false;
            let release: () => void = () => {};
            const idle = new Promise<void>((resolve) => {
                release = () => {
                    released = true;
                    resolve();
                };
            });
            const composedAfterRelease: boolean[] = [];
            const platform: PlatformNode = {
                ...realPlatform,
                createNodeAppHost: (options) => {
                    composedAfterRelease.push(released);

                    return realPlatform.createNodeAppHost(options);
                },
            };
            // Released once the worker asks: a worker that never asks composes with the run still busy.
            const generation = () => {
                setImmediate(release);

                return { busy: !released, idle, sequence: 1, usable: true };
            };
            const dev = await startWorker({ generation, platform });

            try {
                expect(composedAfterRelease).toStrictEqual([true]);
            } finally {
                await dev.stop();
            }
        });

        it("keeps serving the previous version while the last postcodegen hook has failed", async () => {
            expect.assertions(1);

            writeFixture(workdir);

            let usable = true;
            const dev = await startWorker({
                generation: () => {
                    return { busy: false, idle: Promise.resolve(), sequence: 1, usable };
                },
            });

            try {
                const refused = dev.next("the last codegen run did not finish");

                usable = false;
                dev.worker.reload();
                await refused;

                await expect(callQuery(dev.origin, "notes:greeting")).resolves.toStrictEqual({ result: "v1" });
            } finally {
                await dev.stop();
            }
        });

        /** A generation whose run sequence moves once, on the read after `overlapNext()`: one run started during that load. */
        const overlappingGeneration = (usable = true) => {
            let sequence = 1;
            let bump = false;
            let reads = 0;

            return {
                generation: () => {
                    const current = sequence;

                    reads += 1;

                    if (bump) {
                        sequence += 1;
                        bump = false;
                    }

                    return { busy: false, idle: Promise.resolve(), sequence: current, usable };
                },
                overlapNext: () => {
                    bump = true;
                },
                reads: () => reads,
            };
        };

        it("discards a reload whose load a codegen run overlapped, and reloads once that run finishes", async () => {
            expect.assertions(1);

            writeFixture(workdir);

            const runs = overlappingGeneration();
            let composed = 0;
            const platform: PlatformNode = {
                ...realPlatform,
                createNodeAppHost: (options) => {
                    composed += 1;

                    return realPlatform.createNodeAppHost(options);
                },
            };
            const dev = await startWorker({ generation: runs.generation, platform });

            try {
                // The overlapping run settles nothing (as a failed codegen run would), so the retry is the worker's own.
                const reloaded = dev.next("node: reloaded");

                runs.overlapNext();
                dev.worker.reload();
                await reloaded;

                // The start and the retry: the overlapped candidate was never composed.
                expect(composed).toBe(2);
            } finally {
                await dev.stop();
            }
        });

        it("redoes the first load when a codegen run overlapped it", async () => {
            expect.assertions(1);

            writeFixture(workdir);

            const runs = overlappingGeneration();
            const composedAfterReads: number[] = [];
            const platform: PlatformNode = {
                ...realPlatform,
                createNodeAppHost: (options) => {
                    composedAfterReads.push(runs.reads());

                    return realPlatform.createNodeAppHost(options);
                },
            };

            runs.overlapNext();

            const dev = await startWorker({ generation: runs.generation, platform });

            try {
                // Two reads around the overlapped load, then two around the one that served.
                expect(composedAfterReads).toStrictEqual([4]);
            } finally {
                await dev.stop();
            }
        });

        it("refuses to start over output a failed postcodegen hook left", async () => {
            expect.assertions(1);

            writeFixture(workdir);

            // The message names the run, not only the hook: a codegen step after the write can be what failed.
            await expect(startWorker({ generation: overlappingGeneration(false).generation })).rejects.toThrow(
                /the last codegen run did not finish \(a step after writing _generated\/\*, or its postcodegen hook, failed/u,
            );
        });

        it("lets a request in flight finish before a reload closes the listener", async () => {
            expect.assertions(1);

            writeFixture(workdir);

            let release: () => void = () => {};
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            let started: () => void = () => {};
            const requestStarted = new Promise<void>((resolve) => {
                started = resolve;
            });
            const platform: PlatformNode = {
                ...realPlatform,
                createNodeAppHost: (options) => {
                    const host = realPlatform.createNodeAppHost(options);

                    return {
                        ...host,
                        fetch: async (request) => {
                            if (new URL(request.url).pathname !== "/__slow") {
                                return host.fetch(request);
                            }

                            started();
                            await gate;

                            return new Response("finished");
                        },
                    };
                },
                createNodeHttpServer: async (options) => {
                    const server = await realPlatform.createNodeHttpServer(options);

                    return {
                        ...server,
                        // The request finishes only once the reload has begun draining: a reload that closed at once would cut it.
                        drain: async (drainOptions) => {
                            setImmediate(release);

                            return server.drain(drainOptions);
                        },
                    };
                },
            };
            const dev = await startWorker({ platform });

            try {
                const answered = freshFetch(`${dev.origin}/__slow`);

                await requestStarted;

                const reloaded = dev.next("node: reloaded");

                dev.worker.reload();

                const response = await answered;

                await reloaded;

                await expect(response.text()).resolves.toBe("finished");
            } finally {
                await dev.stop();
            }
        });

        it("starts nothing for a reload that a stop overtook", async () => {
            expect.assertions(1);

            writeFixture(workdir);

            let listeners = 0;
            const platform: PlatformNode = {
                ...realPlatform,
                createNodeHttpServer: async (options) => {
                    listeners += 1;

                    return realPlatform.createNodeHttpServer(options);
                },
            };
            const dev = await startWorker({ platform });

            // The reload is still loading when the stop lands.
            dev.worker.reload();
            await dev.stop();

            expect(listeners).toBe(1);
        });

        it("reloads once for a file stamped ahead of the clock, not on every reload", async () => {
            expect.assertions(2);

            writeFixture(workdir);

            const later = new Date(Date.now() + 60_000);

            utimesSync(join(workdir, "src", "worker.ts"), later, later);

            const generating = await startDev(workdir);

            await generating.stop();
            utimesSync(join(workdir, "src", "worker.ts"), later, later);
            // Not advanced on their own: a reload timer stays pending until the test fires it, where the count below sees it.
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

            const { logger, next } = milestoneLogger();
            const reloaded = next("node: reloaded");
            const worker = await startNodeDevWorker({ codegenWatch: false, logger, port: await findAvailablePort(18_870), projectRoot: workdir });

            try {
                // The start saw the stamp and marked one reload.
                expect(vi.getTimerCount()).toBe(1);

                await vi.advanceTimersByTimeAsync(200);
                await reloaded;

                // That reload saw the same stamp again, and arms nothing.
                expect(vi.getTimerCount()).toBe(0);
            } finally {
                vi.useRealTimers();
                worker.kill("SIGTERM");
                await worker.exited;
            }
        });

        it("reloads when a helper the entry imports is moved away and back", async () => {
            expect.assertions(1);

            writeFixture(workdir);
            writeFileSync(join(workdir, "src", "helper.ts"), "export const HELPER = 1;\n", "utf8");
            editFile(join(workdir, "src", "worker.ts"), /^/u, `import "./helper";\n`);

            const dev = await startWorker();

            try {
                const failed = dev.next("reload failed");

                renameSync(join(workdir, "src", "helper.ts"), join(workdir, "src", "helper.moved"));
                await failed;

                const reloaded = dev.next("node: reloaded");

                renameSync(join(workdir, "src", "helper.moved"), join(workdir, "src", "helper.ts"));
                await reloaded;

                await expect(callQuery(dev.origin, "notes:greeting")).resolves.toStrictEqual({ result: "v1" });
            } finally {
                await dev.stop();
            }
        });

        it("binds a Secrets Store secret from .dev.vars when a secrets block filters the plain vars", async () => {
            expect.assertions(1);

            writeFixture(workdir, {
                secrets: { required: [] },
                secrets_store_secrets: [{ binding: "API_KEY", secret_name: "api-key", store_id: "local" }],
            });
            writeFileSync(join(workdir, ".dev.vars"), "API_KEY=from-dev-vars\n", "utf8");

            const dev = await startWorker();

            try {
                await expect(readEnv(dev.origin)).resolves.toStrictEqual({ secret: "from-dev-vars" });
            } finally {
                await dev.stop();
            }
        });

        it("builds the reloaded host only after the previous one has drained", async () => {
            expect.assertions(1);

            writeFixture(workdir);

            const events: string[] = [];
            const platform: PlatformNode = {
                ...realPlatform,
                createNodeAppHost: (options) => {
                    events.push("create");

                    const host = realPlatform.createNodeAppHost(options);

                    return {
                        ...host,
                        close: async (closeOptions) => {
                            events.push("close");

                            const drained = await host.close(closeOptions);

                            events.push("closed");

                            return drained;
                        },
                    };
                },
            };
            const dev = await startWorker({ platform });

            try {
                const reloaded = dev.next("node: reloaded");

                dev.worker.reload();
                await reloaded;

                // Two schedulers over one database would both arm the declared crons and the persisted jobs.
                expect(events).toStrictEqual(["create", "close", "closed", "create"]);
            } finally {
                await dev.stop();
            }
        });

        it("refuses a Secrets Store or Hyperdrive binding named WORKER_ENV, which dev sets itself", async () => {
            expect.assertions(2);

            await expect(startOverConfig({ secrets_store_secrets: [{ binding: "WORKER_ENV", secret_name: "mode", store_id: "local" }] })).rejects.toThrow(
                /sets WORKER_ENV to development itself, and wrangler\.jsonc also declares it in secrets_store_secrets/u,
            );
            await expect(startOverConfig({ hyperdrive: [{ binding: "WORKER_ENV", id: "local" }] })).rejects.toThrow(/also declares it in hyperdrive/u);
        });

        it("refuses a Durable Object binding name that is not an identifier", async () => {
            expect.assertions(1);

            writeFixture(workdir, { durable_objects: { bindings: [{ class_name: "ShardDO", name: "../SHARD" }] } });

            const { logger } = milestoneLogger();

            await expect(startNodeDevWorker({ codegenWatch: false, logger, port: await findAvailablePort(18_870), projectRoot: workdir })).rejects.toThrow(
                /not a valid binding name/u,
            );
        });

        it("resyncs the cron schedule when the generated cron map changes without the codegen watcher", async () => {
            expect.assertions(2);

            writeFixture(workdir);
            writeFileSync(
                join(workdir, "lunora", "crons.ts"),
                `import { cronJobs } from "@lunora/server";\n\nimport { internal } from "./_generated/internal.js";\n\nconst crons = cronJobs();\n\ncrons.cron("tick", "0 * * * *", internal.notes.tick, {});\n\nexport default crons;\n`,
                "utf8",
            );

            const dev = await startWorker();
            const schedules = (): string[] => {
                const database = new DatabaseSync(join(workdir, ".lunora", "node", "SHARD.platform.sqlite3"), { readOnly: true });

                try {
                    return (database.prepare("SELECT expression FROM _lunora_scheduler_crons").all() as { expression: string }[]).map((row) => row.expression);
                } finally {
                    database.close();
                }
            };

            try {
                expect(schedules()).toStrictEqual(["0 * * * *"]);

                const reloaded = dev.next("node: reloaded");

                editFile(join(workdir, "lunora", "_generated", "crons.ts"), /0 \* \* \* \*/gu, "30 * * * *");
                await reloaded;

                expect(schedules()).toStrictEqual(["30 * * * *"]);
            } finally {
                await dev.stop();
            }
        });

        it("warns that queued mail is not delivered when the app produces to the mail queue", async () => {
            expect.assertions(1);

            writeFixture(workdir, { queues: { producers: [{ binding: "MAIL_QUEUE", queue: "lunora-mail" }] } });

            const dev = await startWorker();

            try {
                expect(dev.warnings.join("\n")).toMatch(/queued mail \(the lunora-mail queue, bound as MAIL_QUEUE\) is not delivered in Node dev/u);
            } finally {
                await dev.stop();
            }
        });

        it("names every declared binding it does not compose in the startup warning", async () => {
            expect.assertions(4);

            writeFixture(workdir, {
                assets: { binding: "ASSETS", directory: "./public" },
                // Cache options for named entrypoints are configuration; a typed entry declares a workflow nothing here runs.
                // The served worker itself (`default`, type worker) is neither.
                exports: { default: { type: "worker" }, Nightly: { name: "nightly", type: "workflow" }, Reports: { cache: { enabled: true } } },
                durable_objects: {
                    bindings: [
                        { class_name: "ShardDO", name: "SHARD" },
                        { class_name: "Room", name: "ROOMS", script_name: "rooms-worker" },
                    ],
                },
            });

            const dev = await startWorker();

            try {
                expect(dev.warnings.join("\n")).toMatch(/not bound[^\n]*assets/u);
                expect(dev.warnings.join("\n")).toMatch(/durable_objects\.ROOMS/u);
                expect(dev.warnings.join("\n")).not.toMatch(/exports\.(?:Reports|default)/u);
                expect(dev.warnings.join("\n")).toMatch(/not bound[^\n]*exports\.Nightly \(workflow\)/u);
            } finally {
                await dev.stop();
            }
        });

        it("names an unsupported binding the selected environment declares on its own", async () => {
            expect.assertions(1);

            writeFixture(workdir, {
                env: { preview: { ai: { binding: "AI" }, durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] } } },
            });
            vi.stubEnv("CLOUDFLARE_ENV", "preview");

            try {
                const dev = await startWorker();

                try {
                    expect(dev.warnings.join("\n")).toMatch(/not bound[^\n]*[ ,]ai(?:,|$)/mu);
                } finally {
                    await dev.stop();
                }
            } finally {
                vi.unstubAllEnvs();
            }
        });

        it("starts nothing for a reload that a stop overtook while the previous version drained", async () => {
            expect.assertions(1);

            writeFixture(workdir);

            let composed = 0;
            let stop: () => void = () => {};
            const platform: PlatformNode = {
                ...realPlatform,
                createNodeAppHost: (options) => {
                    composed += 1;

                    const host = realPlatform.createNodeAppHost(options);

                    return {
                        ...host,
                        // The stop lands while the previous version is closing, after the reload passed its first check.
                        close: async (closeOptions) => {
                            stop();

                            return host.close(closeOptions);
                        },
                    };
                },
            };
            const dev = await startWorker({ platform });
            const stopped = new Promise<number>((resolve) => {
                stop = () => {
                    dev.worker.kill("SIGTERM");
                    resolve(0);
                };
            });

            dev.worker.reload();
            await stopped;
            await dev.worker.exited;

            expect(composed).toBe(1);
        });

        it("reloads when _generated/ first appears, with the codegen watcher off", async () => {
            expect.assertions(1);

            writeFixture(workdir);
            // An entry that reads nothing generated, so it loads before codegen has ever run.
            writeFileSync(
                join(workdir, "src", "worker.ts"),
                `export class ShardDO {\n    public async fetch(): Promise<Response> {\n        return new Response("shard");\n    }\n}\n\nexport default { fetch: async (): Promise<Response> => new Response("plain") };\n`,
                "utf8",
            );

            const { logger, next } = milestoneLogger();
            const worker = await startNodeDevWorker({ codegenWatch: false, logger, port: await findAvailablePort(18_870), projectRoot: workdir });

            try {
                const reloaded = next("node: reloaded");

                mkdirSync(join(workdir, "lunora", "_generated"));
                writeFileSync(join(workdir, "lunora", "_generated", "crons.ts"), "export const LUNORA_CRONS = {};\n", "utf8");

                await expect(reloaded).resolves.toBeUndefined();
            } finally {
                worker.kill("SIGTERM");
                await worker.exited;
            }
        });

        it("refuses a malformed entry in a section it composes instead of starting without it", async () => {
            expect.assertions(2);

            await expect(startOverConfig({ durable_objects: { bindings: [{ name: "SHARD" }] } })).rejects.toThrow(/from its "name" and "class_name"/u);
            await expect(startOverConfig({ hyperdrive: [{ id: "local" }] })).rejects.toThrow(/binds each hyperdrive entry by its "binding" name/u);
        });

        it("refuses a name two sources would both put on env", async () => {
            expect.assertions(1);

            writeFixture(workdir, {
                secrets_store_secrets: [{ binding: "API_KEY", secret_name: "api-key", store_id: "local" }],
                vars: { API_KEY: "plain" },
            });

            const { logger } = milestoneLogger();

            await expect(startNodeDevWorker({ codegenWatch: false, logger, port: await findAvailablePort(18_870), projectRoot: workdir })).rejects.toThrow(
                /declares API_KEY \(vars and secrets_store_secrets\) more than once/u,
            );
        });

        it("logs a failed reload with its stack", async () => {
            expect.assertions(1);

            writeFixture(workdir);

            const dev = await startWorker();

            try {
                const failed = dev.next("reload failed");

                editFile(join(workdir, "src", "worker.ts"), /^/u, `throw new Error("entry refused to load");\n`);
                await failed;

                // The stack names where the throw happened, not only its message.
                expect(dev.errors.join("\n")).toMatch(/entry refused to load[\s\S]*worker\.ts/u);
            } finally {
                await dev.stop();
            }
        });

        it("watches a source directory again after its watcher fails", async () => {
            expect.assertions(1);

            writeFixture(workdir);

            const dev = await startWorker();
            const sourceWatcher = (): FSWatcher | undefined => {
                const { calls } = vi.mocked(watch).mock;
                const index = calls.findLastIndex(([path]) => path === join(workdir, "src"));

                return index === -1 ? undefined : (vi.mocked(watch).mock.results[index]?.value as FSWatcher);
            };

            try {
                const rewatched = dev.next("node: reloaded");

                sourceWatcher()?.emit("error", new Error("EMFILE: too many open files, watch"));
                await rewatched;

                // The reload watched the directory afresh, so an edit there reloads again.
                const reloaded = dev.next("node: reloaded");

                editFile(join(workdir, "src", "worker.ts"), /^/u, "// edited\n");

                await expect(reloaded).resolves.toBeUndefined();
            } finally {
                await dev.stop();
            }
        });

        it("refuses a malformed secrets block or vars instead of reading it as empty", async () => {
            expect.assertions(2);

            // A misspelled field would otherwise filter the intended secret out of .dev.vars.
            await expect(startOverConfig({ secrets: { require: ["API_KEY"] } })).rejects.toThrow(/checks every secrets\.required name at startup/u);
            await expect(startOverConfig({ vars: ["SECRET"] })).rejects.toThrow(/reads vars in wrangler\.jsonc as an object of names and values/u);
        });

        it("refuses a required secret with a prototype name, which no env file can deliver", async () => {
            expect.assertions(1);

            await expect(startOverConfig({ secrets: { required: ["__proto__"] } })).rejects.toThrow(/secrets\.required lists "__proto__"/u);
        });

        it("refuses a __proto__ key under vars, which parsing would turn into a prototype and lose", async () => {
            expect.assertions(1);

            writeFixture(workdir, { vars: { LIMIT: "3" } });
            // Written into the raw text: a JavaScript object literal cannot carry a __proto__ key into JSON.stringify.
            editFile(join(workdir, "wrangler.jsonc"), /"vars":\{/u, `"vars":{"__proto__":"x",`);

            await expect(
                startNodeDevWorker({ codegenWatch: false, logger: milestoneLogger().logger, port: await findAvailablePort(18_870), projectRoot: workdir }),
            ).rejects.toThrow(/uses __proto__ as a key at vars\.__proto__/u);
        });

        it("hands JSON var values to the worker as data, null included, as wrangler does", async () => {
            expect.assertions(1);

            writeFixture(workdir, { vars: { LIMIT: 3, NESTED: { enabled: true }, NOTHING: null, ON: false } });

            let env: Record<string, unknown> | undefined;
            const platform: PlatformNode = {
                ...realPlatform,
                createNodeAppHost: (options) => {
                    ({ env } = options);

                    return realPlatform.createNodeAppHost(options);
                },
            };
            const dev = await startWorker({ platform });

            try {
                expect(env).toMatchObject({ LIMIT: 3, NESTED: { enabled: true }, NOTHING: null, ON: false });
            } finally {
                await dev.stop();
            }
        });

        it("hands any other wrangler var name to the worker as a string, constructor and prototype included", async () => {
            expect.assertions(1);

            writeFixture(workdir, { vars: { "API-URL": "https://api.local", "app.mode": "demo", constructor: "c", prototype: "p" } });

            let env: Record<string, unknown> | undefined;
            const platform: PlatformNode = {
                ...realPlatform,
                createNodeAppHost: (options) => {
                    ({ env } = options);

                    return realPlatform.createNodeAppHost(options);
                },
            };
            const dev = await startWorker({ platform });

            try {
                // Own string properties, not what Object.prototype carries under those names.
                expect(
                    Object.fromEntries(
                        ["API-URL", "app.mode", "constructor", "prototype"].map((name) => [
                            name,
                            env !== undefined && Object.hasOwn(env, name) ? env[name] : null,
                        ]),
                    ),
                ).toStrictEqual({ "API-URL": "https://api.local", "app.mode": "demo", constructor: "c", prototype: "p" });
            } finally {
                await dev.stop();
            }
        });

        it("refuses a second Hyperdrive binding, which would reach the same DATABASE_URL as the first", async () => {
            expect.assertions(1);

            await expect(
                startOverConfig({
                    hyperdrive: [
                        { binding: "PRIMARY_DB", id: "primary" },
                        { binding: "REPORTING_DB", id: "reporting" },
                    ],
                }),
            ).rejects.toThrow(
                /builds the Hyperdrive binding from DATABASE_URL, so it serves one binding, and wrangler\.jsonc declares PRIMARY_DB, REPORTING_DB/u,
            );
        });

        it("binds a Hyperdrive binding named __proto__ as an own env property", async () => {
            expect.assertions(1);

            writeFixture(workdir, { hyperdrive: [{ binding: "__proto__", id: "local" }] });
            // eslint-disable-next-line no-secrets/no-secrets -- a fixture dev-vars line with a passwordless local URL
            writeFileSync(join(workdir, ".dev.vars"), "DATABASE_URL=postgres://app@db.local:5433/app\n", "utf8");

            let ownBinding: boolean | undefined;
            const platform: PlatformNode = {
                ...realPlatform,
                createNodeAppHost: (options) => {
                    ownBinding = options.env !== undefined && Object.hasOwn(options.env, "__proto__");

                    return realPlatform.createNodeAppHost(options);
                },
            };
            const dev = await startWorker({ platform });

            try {
                expect(ownBinding).toBe(true);
            } finally {
                await dev.stop();
            }
        });

        it("reloads once a main that named a missing file is created", async () => {
            expect.assertions(1);

            writeFixture(workdir);

            const dev = await startWorker();

            try {
                const failed = dev.next("reload failed");

                editFile(join(workdir, "wrangler.jsonc"), /"main":\s*"src\/worker\.ts"/u, `"main": "src/later.ts"`);
                await failed;

                const reloaded = dev.next("node: reloaded");

                writeAlternateEntry(workdir, "later.ts", "later");
                await reloaded;

                await expect(readWhich(dev.origin)).resolves.toBe("later");
            } finally {
                await dev.stop();
            }
        });

        it("watches the wrangler config and .dev.vars again after their watcher fails", async () => {
            expect.assertions(1);

            writeFixture(workdir, { secrets_store_secrets: [{ binding: "API_KEY", secret_name: "api-key", store_id: "local" }] });
            writeFileSync(join(workdir, ".dev.vars"), "API_KEY=first\n", "utf8");

            const dev = await startWorker();
            const configWatcher = (): FSWatcher | undefined => {
                const { calls } = vi.mocked(watch).mock;
                const index = calls.findLastIndex(([path]) => path === workdir);

                return index === -1 ? undefined : (vi.mocked(watch).mock.results[index]?.value as FSWatcher);
            };

            try {
                const rewatched = dev.next("node: reloaded");

                configWatcher()?.emit("error", new Error("EMFILE: too many open files, watch"));
                await rewatched;

                const reloaded = dev.next("node: reloaded");

                editFile(join(workdir, ".dev.vars"), /API_KEY=first/u, "API_KEY=second");
                await reloaded;

                await expect(readEnv(dev.origin)).resolves.toMatchObject({ secret: "second" });
            } finally {
                await dev.stop();
            }
        });

        it("fails the start with the port released when the config directory cannot be watched", async () => {
            expect.assertions(2);

            writeFixture(workdir);

            const generating = await startDev(workdir);

            await generating.stop();

            const port = await findAvailablePort(18_870);
            const { logger } = milestoneLogger();

            // Searchable but not readable: files load by path, and a watch on the directory itself is refused.
            chmodSync(workdir, 0o311);

            try {
                await expect(startNodeDevWorker({ codegenWatch: false, logger, port, projectRoot: workdir })).rejects.toThrow(/EACCES/u);
            } finally {
                chmodSync(workdir, 0o755);
            }

            await expect(portIsFree(port)).resolves.toBe(true);
        });
    });

    it("watches and reloads a worker entry shared from outside the project", async () => {
        expect.assertions(2);

        const appRoot = join(workdir, "app");
        const sharedEntry = join(workdir, "shared", "entry.ts");
        const sharedSource = (version: string): string => `import worker from "../app/src/worker";

export { ShardDO } from "../app/src/worker";

export default {
    fetch: (request: Request, env: never, ctx: never): Promise<Response> | Response =>
        new URL(request.url).pathname === "/__which" ? new Response(${JSON.stringify(version)}) : worker.fetch(request, env, ctx),
};
`;

        mkdirSync(appRoot);
        mkdirSync(join(workdir, "shared"));
        writeFixture(appRoot, { main: "../shared/entry.ts" });
        writeFileSync(sharedEntry, sharedSource("shared-v1"), "utf8");

        const dev = await startDev(appRoot);

        try {
            await expect(readWhich(dev.origin)).resolves.toBe("shared-v1");

            const reloaded = dev.next("node: reloaded");

            writeFileSync(sharedEntry, sharedSource("shared-v2"), "utf8");
            await reloaded;

            await expect(readWhich(dev.origin)).resolves.toBe("shared-v2");
        } finally {
            await dev.stop();
        }
    });

    it("follows a shared worker's helper that sits outside the entry's own directory", async () => {
        expect.assertions(2);

        const appRoot = join(workdir, "app");
        const flag = join(workdir, "shared", "lib", "flag.ts");

        mkdirSync(appRoot);
        mkdirSync(join(workdir, "shared", "worker"), { recursive: true });
        mkdirSync(join(workdir, "shared", "lib"));
        writeFixture(appRoot, { main: "../shared/worker/entry.ts" });
        writeFileSync(flag, `export const FLAG = "one";\n`, "utf8");
        writeFileSync(
            join(workdir, "shared", "worker", "entry.ts"),
            `import worker from "../../app/src/worker";
import { FLAG } from "../lib/flag";

export { ShardDO } from "../../app/src/worker";

export default {
    fetch: (request: Request, env: never, ctx: never): Promise<Response> | Response =>
        new URL(request.url).pathname === "/__which" ? new Response(FLAG) : worker.fetch(request, env, ctx),
};
`,
            "utf8",
        );

        const dev = await startDev(appRoot);

        try {
            await expect(readWhich(dev.origin)).resolves.toBe("one");

            const reloaded = dev.next("node: reloaded");

            writeFileSync(flag, `export const FLAG = "two";\n`, "utf8");
            await reloaded;

            await expect(readWhich(dev.origin)).resolves.toBe("two");
        } finally {
            await dev.stop();
        }
    });

    it("reloads on an edit to a sibling workspace package the app imports", async () => {
        expect.assertions(2);

        const appRoot = join(workdir, "apps", "demo");
        const flag = join(workdir, "packages", "flags", "src", "flag.ts");

        writeFileSync(join(workdir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n", "utf8");
        mkdirSync(appRoot, { recursive: true });
        mkdirSync(dirname(flag), { recursive: true });
        writeFileSync(join(workdir, "packages", "flags", "package.json"), JSON.stringify({ name: "flags", private: true, type: "module" }), "utf8");
        writeFileSync(flag, `export const FLAG = "one";\n`, "utf8");
        writeFixture(appRoot, { main: "src/entry.ts" });
        writeFileSync(
            join(appRoot, "src", "entry.ts"),
            `import worker from "./worker";
import { FLAG } from "../../../packages/flags/src/flag";

export { ShardDO } from "./worker";

export default {
    fetch: (request: Request, env: never, ctx: never): Promise<Response> | Response =>
        new URL(request.url).pathname === "/__which" ? new Response(FLAG) : worker.fetch(request, env, ctx),
};
`,
            "utf8",
        );

        const dev = await startDev(appRoot);

        try {
            await expect(readWhich(dev.origin)).resolves.toBe("one");

            const reloaded = dev.next("node: reloaded");

            writeFileSync(flag, `export const FLAG = "two";\n`, "utf8");
            await reloaded;

            await expect(readWhich(dev.origin)).resolves.toBe("two");
        } finally {
            await dev.stop();
        }
    });

    it("refuses an explicit --remote before provisioning anything", async () => {
        expect.assertions(2);

        writeFixture(workdir);

        await expect(
            runDevCommand({
                cwd: workdir,
                logger: milestoneLogger().logger,
                remote: true,
                studio: false,
                target: "node",
                workerPort: await findAvailablePort(18_900),
            }),
        ).rejects.toThrow(/the Node target has no remote bindings/u);
        expect(provisionBindings).not.toHaveBeenCalled();
    });

    it("runs local, with a warning, when remote is only the project's or the shell's default", async () => {
        expect.assertions(1);

        writeFixture(workdir);

        const dev = await startDev(workdir, { remote: true, remoteFromDefault: true });

        try {
            expect(dev.warnings.join("\n")).toMatch(/does not apply to --target node/u);
        } finally {
            await dev.stop();
        }
    });

    it("does not tail Docker containers, which the Node host never runs", async () => {
        expect.assertions(1);

        writeFixture(workdir);

        const dev = await startDev(workdir);

        try {
            expect(startContainerLogStreaming).not.toHaveBeenCalled();
        } finally {
            await dev.stop();
        }
    });
});

describe(planNodeDevServer, () => {
    it("advertises the IPv4 loopback the Node listener binds, not localhost", () => {
        expect.assertions(1);

        const plan = planNodeDevServer({ cwd: "/app", options: { cwd: "/app", logger: milestoneLogger().logger }, studioPort: 6173, workerPort: 8787 });

        // `localhost` can resolve to ::1 first, where the probe, the Studio proxy and the tunnel would find nothing.
        expect(plan.workerOrigin).toBe("http://127.0.0.1:8787");
    });
});

describe("lunora dev --target node codegen settlements", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = realpathSync(mkdtempSync(join(tmpdir(), "lunora-cli-node-dev-settle-")));
        writeFileSync(join(workdir, "lunora.config.ts"), `export default { target: "node" };\n`, "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    /** Run `lunora dev` with a fake codegen watcher and a fake Node worker, settling one run at `when`. */
    const runWithFakes = async (
        when: "after-start" | "before-start" | "during-start",
        run?: { hookRan: boolean; sequence?: number; startup: boolean },
        loadedSequence?: number,
    ) => {
        const settled = { hookRan: run?.hookRan ?? false, sequence: run?.sequence ?? 1, startup: run?.startup ?? false };

        const reload = vi.fn<() => void>();
        let onSettled: ((settled: { hookRan: boolean; sequence: number; startup: boolean }) => void) | undefined;
        let exit: (code: number) => void = () => {};
        const exited = new Promise<number>((resolve) => {
            exit = resolve;
        });
        const { logger } = milestoneLogger();

        const dev = runDevCommand({
            cwd: workdir,
            logger,
            startCodegen: (options) => {
                ({ onSettled } = options);

                if (when === "before-start") {
                    onSettled?.(settled);
                }

                return { close: async () => {}, watchAvailable: true } as never;
            },
            startNodeWorker: async () => {
                if (when === "during-start") {
                    onSettled?.(settled);
                }

                // Stops as soon as it is up: the reload call is all this test reads. After the handler has registered the
                // worker's reload, which happens once this start resolves.
                setImmediate(() => {
                    if (when === "after-start") {
                        onSettled?.(settled);
                    }

                    exit(0);
                });

                return { exited, kill: () => {}, loadedSequence, reload };
            },
            studio: false,
            target: "node",
            waitForInterrupt: async () => 0,
            workerPort: await findAvailablePort(18_900),
        });

        await dev;

        return reload;
    };

    it("does not restart for a hooked run the first load already waited out", async () => {
        expect.assertions(2);

        // The first load read run 1, so its settlement during the start is already in what serves; run 2 is not.
        await expect(runWithFakes("during-start", { hookRan: true, sequence: 1, startup: true }, 1)).resolves.not.toHaveBeenCalled();
        await expect(runWithFakes("during-start", { hookRan: false, sequence: 2, startup: false }, 1)).resolves.toHaveBeenCalledTimes(1);
    });

    it("tells the worker to watch lunora/ and the config itself when the codegen watcher could not start", async () => {
        expect.assertions(1);

        let codegenWatch: boolean | undefined;
        let exit: (code: number) => void = () => {};
        const exited = new Promise<number>((resolve) => {
            exit = resolve;
        });

        await runDevCommand({
            cwd: workdir,
            logger: milestoneLogger().logger,
            // Requested, but unavailable: no settled run will ever reach the worker.
            startCodegen: () => ({ close: async () => {}, watchAvailable: false }) as never,
            startNodeWorker: async (inputs) => {
                ({ codegenWatch } = inputs);
                setImmediate(() => {
                    exit(0);
                });

                return { exited, kill: () => {}, reload: () => {} };
            },
            studio: false,
            target: "node",
            waitForInterrupt: async () => 0,
            workerPort: await findAvailablePort(18_900),
        });

        expect(codegenWatch).toBe(false);
    });

    it("reloads once the host is up for a run that settled while it was loading", async () => {
        expect.assertions(1);

        await expect(runWithFakes("during-start")).resolves.toHaveBeenCalledTimes(1);
    });

    it("does not reload for a run that settled before the host started loading", async () => {
        expect.assertions(1);

        await expect(runWithFakes("before-start")).resolves.not.toHaveBeenCalled();
    });

    it("does not reload for the startup run once the host is up, without a postcodegen hook", async () => {
        expect.assertions(1);

        await expect(runWithFakes("after-start", { hookRan: false, startup: true })).resolves.not.toHaveBeenCalled();
    });

    it("reloads for the startup run whose postcodegen hook may have rewritten output during the load", async () => {
        expect.assertions(1);

        await expect(runWithFakes("during-start", { hookRan: true, startup: true })).resolves.toHaveBeenCalledTimes(1);
    });

    it("still reloads for an edit's run once the host is up", async () => {
        expect.assertions(1);

        await expect(runWithFakes("after-start")).resolves.toHaveBeenCalledTimes(1);
    });

    it("does not reload for the startup run, which wrote its output before the host started loading", async () => {
        expect.assertions(1);

        await expect(runWithFakes("during-start", { hookRan: false, startup: true })).resolves.not.toHaveBeenCalled();
    });
});
