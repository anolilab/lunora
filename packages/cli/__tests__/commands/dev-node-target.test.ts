import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDevCommand } from "../../src/commands/dev/handler";
import { startNodeDevWorker } from "../../src/commands/dev/node-dev-server";
import type { NodeDevWorker } from "../../src/commands/dev/types";
import { findAvailablePort } from "../../src/util/free-port";
import type { Logger } from "../../src/util/logger";

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

/** Start `lunora dev --target node` on `workdir` and resolve once it serves; `stop` ends it and resolves with its result. */
const startDev = async (workdir: string) => {
    const port = await findAvailablePort(18_870);
    const { errors, logger, next } = milestoneLogger();
    const serving = next("node: serving");
    let worker: NodeDevWorker | undefined;

    const run = runDevCommand({
        cwd: workdir,
        logger,
        studio: false,
        startNodeWorker: async (inputs) => {
            worker = await startNodeDevWorker(inputs);

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
});
