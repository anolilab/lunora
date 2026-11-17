import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDevCommand } from "../../src/commands/dev/handler";
import { startNodeDevWorker } from "../../src/commands/dev/node-dev-server";
import type { NodeDevWorker } from "../../src/commands/dev/types";
import { findAvailablePort } from "../../src/util/free-port";
import type { Logger } from "../../src/util/logger";

/** This package's node_modules: the fixture links it so `@lunora/*` resolve to the workspace builds. */
const PACKAGE_NODE_MODULES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules");

const notesSource = (greeting: string): string => `import { mutation, query, v } from "./_generated/server.js";

export const greeting = query.query(async (): Promise<string> => ${JSON.stringify(greeting)});

export const add = mutation.input({ text: v.string() }).mutation(async ({ args, ctx }) => ctx.db.insert("notes", { text: args.text }));
`;

const writeFixture = (root: string): void => {
    mkdirSync(join(root, "lunora"));
    mkdirSync(join(root, "src"));
    symlinkSync(PACKAGE_NODE_MODULES, join(root, "node_modules"), "dir");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "node-target-app", private: true, type: "module" }), "utf8");
    writeFileSync(join(root, "lunora.config.ts"), `export default { target: "node" };\n`, "utf8");
    writeFileSync(
        join(root, "wrangler.jsonc"),
        JSON.stringify({
            compatibility_date: "2026-10-01",
            durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
            main: "src/worker.ts",
            migrations: [{ new_sqlite_classes: ["ShardDO"], tag: "v1" }],
            name: "node-target-app",
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

export const ShardDO = createShardDO();

let worker: ReturnType<typeof createWorker> | undefined;

export default {
    async fetch(request: Request, env: { SHARD: never }, ctx: never): Promise<Response> {
        worker ??= createWorker({ shardDO: env.SHARD });

        return worker.fetch(request, env, ctx);
    },
};
`,
        "utf8",
    );
};

/** A logger whose info lines can be awaited: each wait resolves on the next line containing the text, never on a timer. */
const milestoneLogger = (): { logger: Logger; next: (text: string) => Promise<void> } => {
    const waiters: { resolve: () => void; text: string }[] = [];
    const info = (message: string): void => {
        for (const waiter of waiters.filter((candidate) => message.includes(candidate.text))) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve();
        }
    };

    return {
        logger: { error: () => {}, info, success: () => {}, warn: () => {} },
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

describe("lunora dev --target node", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = realpathSync(mkdtempSync(join(tmpdir(), "lunora-cli-node-dev-")));
        writeFixture(workdir);
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("serves a query over HTTP and picks up a changed function", async () => {
        expect.assertions(4);

        const port = await findAvailablePort(18_870);
        const { logger, next } = milestoneLogger();
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
            throw new Error(`lunora dev ended with code ${String(result.code)} before serving`);
        });

        try {
            await Promise.race([serving, ended]);

            const origin = `http://localhost:${String(port)}`;

            await expect(callQuery(origin, "notes:greeting")).resolves.toStrictEqual({ result: "v1" });
            // A write lands in the shard's SQLite, so the request reached a real ShardDO on the Node host.
            await expect(callQuery(origin, "notes:add", { text: "hello" })).resolves.toStrictEqual({ result: expect.any(String) });

            const reloaded = next("node: reloaded");

            writeFileSync(join(workdir, "lunora", "notes.ts"), notesSource("v2"), "utf8");
            await reloaded;

            await expect(callQuery(origin, "notes:greeting")).resolves.toStrictEqual({ result: "v2" });
        } finally {
            worker?.kill("SIGTERM");
        }

        await expect(run).resolves.toMatchObject({ code: 0 });
    });
});
