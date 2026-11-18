import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createNodeAppHost, createNodeHttpServer, createNodeHyperdrive, createNodeSecretBindings } from "@lunora/platform-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDevCommand } from "../../src/commands/dev/handler";
import { startNodeDevWorker } from "../../src/commands/dev/node-dev-server";
import type { NodeDevWorker, PlatformNode } from "../../src/commands/dev/types";
import { findAvailablePort } from "../../src/util/free-port";
import type { Logger } from "../../src/util/logger";

/** The project's real `@lunora/platform-node`, which a test wraps to inject a failure. */
const realPlatform = { createNodeAppHost, createNodeHttpServer, createNodeHyperdrive, createNodeSecretBindings } as unknown as PlatformNode;

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
}

let worker: ReturnType<typeof createWorker> | undefined;

export default {
    async fetch(request: Request, env: Env, ctx: never): Promise<Response> {
        if (new URL(request.url).pathname === "/__env") {
            return Response.json({ hyperdrive: env.HYPERDRIVE && { host: env.HYPERDRIVE.host, port: env.HYPERDRIVE.port }, secret: await env.API_KEY?.get() });
        }

        worker ??= createWorker({ shardDO: env.SHARD });

        return worker.fetch(request, env, ctx);
    },
};
`,
        "utf8",
    );
};

/** A logger whose info lines can be awaited: each wait resolves on the next line containing the text, never on a timer. */
const milestoneLogger = (): { errors: string[]; logger: Logger; next: (text: string) => Promise<void> } => {
    const waiters: { resolve: () => void; text: string }[] = [];
    const errors: string[] = [];
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
            },
            info,
            success: () => {},
            warn: () => {},
        },
        next: async (text) =>
            new Promise<void>((resolve) => {
                waiters.push({ resolve, text });
            }),
    };
};

const callQuery = async (origin: string, functionPath: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const response = await fetch(`${origin}/_lunora/rpc`, {
        body: JSON.stringify({ args, functionPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

    return response.json();
};

/**
 * Start `lunora dev --target node` on `workdir` and resolve once it serves; `stop` ends it and resolves with its result.
 * `firstReload` is armed before the start, so a reload the start itself triggers is not missed.
 */
const startDev = async (workdir: string, options: { codegen?: boolean; platform?: PlatformNode } = {}) => {
    const port = await findAvailablePort(18_870);
    const { errors, logger, next } = milestoneLogger();
    const serving = next("node: serving");
    const firstReload = next("node: reloaded");
    let worker: NodeDevWorker | undefined;

    const run = runDevCommand({
        codegen: options.codegen,
        cwd: workdir,
        logger,
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
                expect(dev.errors.join(" ")).toContain("could not serve the reloaded worker");
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
        ).rejects.toThrow(/createNodeAppHost \(1\.0\.0-alpha\.220 or later\)/u);
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
    const runWithFakes = async (when: "before-start" | "during-start", startup = false) => {
        const run = { startup };

        const reload = vi.fn<() => void>();
        let onSettled: ((settled: { startup: boolean }) => void) | undefined;
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
                    onSettled?.(run);
                }

                return { close: async () => {}, watchAvailable: true } as never;
            },
            startNodeWorker: async () => {
                if (when === "during-start") {
                    onSettled?.(run);
                }

                // Stops as soon as it is up: the reload call is all this test reads.
                queueMicrotask(() => {
                    exit(0);
                });

                return { exited, kill: () => {}, reload };
            },
            studio: false,
            target: "node",
            waitForInterrupt: async () => 0,
            workerPort: await findAvailablePort(18_900),
        });

        await dev;

        return reload;
    };

    it("reloads once the host is up for a run that settled while it was loading", async () => {
        expect.assertions(1);

        await expect(runWithFakes("during-start")).resolves.toHaveBeenCalledTimes(1);
    });

    it("does not reload for a run that settled before the host started loading", async () => {
        expect.assertions(1);

        await expect(runWithFakes("before-start")).resolves.not.toHaveBeenCalled();
    });

    it("does not reload for the startup run, which wrote its output before the host started loading", async () => {
        expect.assertions(1);

        await expect(runWithFakes("during-start", true)).resolves.not.toHaveBeenCalled();
    });
});
