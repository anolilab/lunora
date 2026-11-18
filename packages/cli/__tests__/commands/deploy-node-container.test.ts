import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDeployCommand } from "../../src/commands/deploy/handler";
import { NODE_DEPLOY_DIRECTORY, NODE_IMAGE } from "../../src/commands/deploy/node-container";
import type { Logger } from "../../src/util/logger";

/** This package's node_modules: the fixture links it so `@lunora/*` and esbuild resolve to the workspace copies. */
const PACKAGE_NODE_MODULES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules");

/** The `better-sqlite3` the workspace's platform-node runs on, linked into the artifact in place of the image's `npm install`. */
const BETTER_SQLITE3 = dirname(createRequire(join(PACKAGE_NODE_MODULES, "@lunora", "platform-node", "package.json")).resolve("better-sqlite3/package.json"));

const silentLogger = (): Logger => {
    return { error: () => {}, info: () => {}, success: () => {}, warn: () => {} };
};

const writeFixture = (root: string): void => {
    mkdirSync(join(root, "lunora"));
    mkdirSync(join(root, "src"));
    symlinkSync(PACKAGE_NODE_MODULES, join(root, "node_modules"), "dir");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "node-container-app", private: true, type: "module" }), "utf8");
    writeFileSync(join(root, "lunora.config.ts"), `export default { target: "node" };\n`, "utf8");
    writeFileSync(
        join(root, "wrangler.jsonc"),
        JSON.stringify({
            compatibility_date: "2026-10-01",
            durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
            main: "src/worker.ts",
            migrations: [{ new_sqlite_classes: ["ShardDO"], tag: "v1" }],
            name: "node-container-app",
            secrets_store_secrets: [{ binding: "STRIPE_KEY", secret_name: "stripe", store_id: "store" }],
        }),
        "utf8",
    );
    writeFileSync(
        join(root, "lunora", "schema.ts"),
        `import { defineSchema, defineTable, v } from "@lunora/server";\n\nexport default defineSchema({ notes: defineTable({ text: v.string() }) });\n`,
        "utf8",
    );
    writeFileSync(
        join(root, "lunora", "notes.ts"),
        `import { mutation, query, v } from "./_generated/server.js";

export const greeting = query.query(async (): Promise<string> => "from the container");

export const add = mutation.input({ text: v.string() }).mutation(async ({ args, ctx }) => ctx.db.insert("notes", { text: args.text }));
`,
        "utf8",
    );
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

const callFunction = async (origin: string, functionPath: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const response = await fetch(`${origin}/_lunora/rpc`, {
        body: JSON.stringify({ args, functionPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

    return response.json();
};

/** Resolves with the origin the server prints once it listens, or rejects when it exits first. Never a timer. */
const listening = async (child: ChildProcess): Promise<string> =>
    new Promise<string>((resolve, reject) => {
        let stdout = "";
        let stderr = "";

        child.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");

            const match = /lunora: listening on (\S+)/u.exec(stdout);

            if (match?.[1] !== undefined) {
                resolve(match[1]);
            }
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
        });
        child.once("exit", (code) => {
            reject(new Error(`server.mjs exited with ${String(code)} before listening:\n${stderr}`));
        });
    });

const dockerAvailable = (): boolean => {
    try {
        // eslint-disable-next-line sonarjs/no-os-command-from-path -- the engine resolves from PATH; fixed args, no shell
        return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
    } catch {
        return false;
    }
};

describe("lunora deploy --target node", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = realpathSync(mkdtempSync(join(tmpdir(), "lunora-cli-node-deploy-")));
        writeFixture(workdir);
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("writes a container build context whose server serves a query when run with node", async () => {
        expect.assertions(11);

        const result = await runDeployCommand({ cwd: workdir, interactive: false, logger: silentLogger(), target: "node" });
        const artifact = join(workdir, NODE_DEPLOY_DIRECTORY);

        expect(result).toMatchObject({ code: 0, container: { directory: artifact } });

        for (const file of [".dockerignore", "Dockerfile", "package.json", "README.md", "server.mjs"]) {
            expect(existsSync(join(artifact, file)), file).toBe(true);
        }

        const dockerfile = readFileSync(join(artifact, "Dockerfile"), "utf8");

        expect(dockerfile).toContain(`FROM ${NODE_IMAGE}`);
        // The secrets_store binding is a required variable, so the README must name it.
        expect(readFileSync(join(artifact, "README.md"), "utf8")).toContain("`STRIPE_KEY`");

        mkdirSync(join(artifact, "node_modules"));
        symlinkSync(BETTER_SQLITE3, join(artifact, "node_modules", "better-sqlite3"), "dir");

        const child = spawn(process.execPath, ["server.mjs"], {
            cwd: artifact,
            env: { LUNORA_DATA_DIR: join(workdir, "data"), PATH: process.env.PATH, PORT: "0" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        const exited = new Promise<number | null>((resolve) => {
            child.once("exit", resolve);
        });

        try {
            const origin = await listening(child);

            await expect(callFunction(origin, "notes:greeting")).resolves.toStrictEqual({ result: "from the container" });
            // A write lands in the shard's SQLite under LUNORA_DATA_DIR, so the request reached a real ShardDO.
            await expect(callFunction(origin, "notes:add", { text: "hello" })).resolves.toStrictEqual({ result: expect.any(String) });
            expect(existsSync(join(workdir, "data", "SHARD"))).toBe(true);
        } finally {
            child.kill("SIGTERM");
            await exited;
        }
    });

    it("refuses a flag that acts on a hosted deployment before writing anything", async () => {
        expect.assertions(2);

        const result = await runDeployCommand({ cwd: workdir, interactive: false, logger: silentLogger(), migrate: true, target: "node" });

        expect(result).toMatchObject({ code: 2, error: expect.stringMatching(/--migrate acts on a hosted deployment/u) });
        expect(existsSync(join(workdir, NODE_DEPLOY_DIRECTORY))).toBe(false);
    });

    // A real image build pulls the base image and compiles better-sqlite3: only where an engine runs, never in CI.
    it.runIf(process.env.CI === undefined && dockerAvailable())(
        "builds the image with --image when Docker answers",
        async () => {
            expect.assertions(1);

            const image = `lunora-node-container-test:${String(process.pid)}`;

            try {
                const result = await runDeployCommand({ cwd: workdir, image, interactive: false, logger: silentLogger(), target: "node" });

                expect(result).toMatchObject({ code: 0, container: { image } });
            } finally {
                // eslint-disable-next-line sonarjs/no-os-command-from-path -- the engine resolves from PATH; fixed args, no shell
                spawnSync("docker", ["image", "rm", "-f", image], { stdio: "ignore" });
            }
        },
        600_000,
    );
});
