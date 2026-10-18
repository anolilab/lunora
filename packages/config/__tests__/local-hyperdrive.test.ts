import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PgliteRuntime } from "../src/cloudflare/local-hyperdrive";
import { bindingsNeedingDatabase, startLocalHyperdrive } from "../src/cloudflare/local-hyperdrive";

const VAR = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_";

describe("local hyperdrive", () => {
    let root: string;

    const writeWrangler = (hyperdrive: unknown): void => {
        writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify({ hyperdrive, name: "app" }), "utf8");
    };

    /** A runtime whose "servers" are recorded, so no WASM engine boots. */
    const fakeRuntime = () => {
        const stops: string[] = [];
        const directories: string[] = [];
        const runtime: PgliteRuntime = {
            createServer: async (directory) => {
                directories.push(directory);

                const name = directory.split("/").at(-1) ?? "";

                return {
                    connectionString: `postgres://local/${name}`,
                    stop: async () => {
                        stops.push(name);
                    },
                };
            },
        };

        return { directories, runtime, stops };
    };

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-local-hyperdrive-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    describe(bindingsNeedingDatabase, () => {
        it("lists a binding that has neither a localConnectionString nor the environment variable", () => {
            expect.assertions(1);

            writeWrangler([
                { binding: "DB_A", id: "a" },
                { binding: "DB_B", id: "b", localConnectionString: "postgres://mine" },
                { binding: "DB_C", id: "c" },
            ]);

            expect(bindingsNeedingDatabase(root, { [`${VAR}DB_C`]: "postgres://env" })).toStrictEqual(["DB_A"]);
        });

        it("counts wrangler's deprecated variable name as a database too", () => {
            expect.assertions(1);

            writeWrangler([{ binding: "DB", id: "a" }]);

            expect(bindingsNeedingDatabase(root, { WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB: "postgres://env" })).toStrictEqual([]);
        });

        it("is empty without a wrangler config or hyperdrive entries", () => {
            expect.assertions(2);

            expect(bindingsNeedingDatabase(root, {})).toStrictEqual([]);

            writeWrangler(undefined);

            expect(bindingsNeedingDatabase(root, {})).toStrictEqual([]);
        });
    });

    describe(startLocalHyperdrive, () => {
        it("serves each unbacked binding from its own persisted directory and exports the connection string", async () => {
            expect.assertions(4);

            writeWrangler([
                { binding: "DB_A", id: "a" },
                { binding: "DB_B", id: "b" },
            ]);

            const { directories, runtime } = fakeRuntime();
            const env: NodeJS.ProcessEnv = {};
            const local = await startLocalHyperdrive({ env, load: async () => runtime, projectRoot: root });

            expect(local?.bindings).toStrictEqual(["DB_A", "DB_B"]);
            expect(env[`${VAR}DB_A`]).toBe("postgres://local/DB_A");
            expect(env[`${VAR}DB_B`]).toBe("postgres://local/DB_B");
            expect(directories.map((directory) => existsSync(directory) && directory.includes(join(".wrangler", "state", "lunora-pglite")))).toStrictEqual([
                true,
                true,
            ]);
        });

        it("leaves a binding with its own database alone and never loads PGlite for it", async () => {
            expect.assertions(2);

            writeWrangler([{ binding: "DB", id: "a", localConnectionString: "postgres://mine" }]);

            const load = vi.fn<() => Promise<PgliteRuntime | undefined>>(async () => fakeRuntime().runtime);

            await expect(startLocalHyperdrive({ env: {}, load, projectRoot: root })).resolves.toBeUndefined();
            expect(load).not.toHaveBeenCalled();
        });

        it("never overrides a variable the developer set", async () => {
            expect.assertions(2);

            writeWrangler([{ binding: "DB", id: "a" }]);

            const env: NodeJS.ProcessEnv = { [`${VAR}DB`]: "postgres://mine" };
            const load = vi.fn<() => Promise<PgliteRuntime | undefined>>(async () => fakeRuntime().runtime);

            await startLocalHyperdrive({ env, load, projectRoot: root });

            expect(env[`${VAR}DB`]).toBe("postgres://mine");
            expect(load).not.toHaveBeenCalled();
        });

        it("stop removes the variables and stops every server", async () => {
            expect.assertions(2);

            writeWrangler([
                { binding: "DB_A", id: "a" },
                { binding: "DB_B", id: "b" },
            ]);

            const { runtime, stops } = fakeRuntime();
            const env: NodeJS.ProcessEnv = {};
            const local = await startLocalHyperdrive({ env, load: async () => runtime, projectRoot: root });

            await local?.stop();

            expect(env).toStrictEqual({});
            expect(stops.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["DB_A", "DB_B"]);
        });

        it("says how to install PGlite, and starts nothing, when it is missing", async () => {
            expect.assertions(3);

            writeWrangler([{ binding: "DB", id: "a" }]);

            const env: NodeJS.ProcessEnv = {};
            const warnings: string[] = [];

            await expect(
                startLocalHyperdrive({ env, load: async () => undefined, onWarning: (line) => warnings.push(line), projectRoot: root }),
            ).resolves.toBeUndefined();

            expect(warnings.join(" ")).toContain("pnpm add -D @electric-sql/pglite @electric-sql/pglite-socket");
            expect(env).toStrictEqual({});
        });

        it("rolls back the servers already started when a later one fails", async () => {
            expect.assertions(3);

            writeWrangler([
                { binding: "DB_A", id: "a" },
                { binding: "DB_B", id: "b" },
            ]);

            const stops: string[] = [];
            const runtime: PgliteRuntime = {
                createServer: async (directory) => {
                    if (directory.endsWith("DB_B")) {
                        throw new Error("boom");
                    }

                    return {
                        connectionString: "postgres://local/a",
                        stop: async () => {
                            stops.push("DB_A");
                        },
                    };
                },
            };
            const env: NodeJS.ProcessEnv = {};
            const warnings: string[] = [];

            await expect(
                startLocalHyperdrive({ env, load: async () => runtime, onWarning: (line) => warnings.push(line), projectRoot: root }),
            ).resolves.toBeUndefined();

            expect(stops).toStrictEqual(["DB_A"]);
            expect({ env, warnings: warnings.join(" ").includes("boom") }).toStrictEqual({ env: {}, warnings: true });
        });

        it("boots the real embedded Postgres and serves a loopback connection string", async () => {
            expect.assertions(3);

            writeWrangler([{ binding: "DB", id: "a" }]);

            const env: NodeJS.ProcessEnv = {};
            const local = await startLocalHyperdrive({ env, projectRoot: root });

            try {
                expect(local?.bindings).toStrictEqual(["DB"]);
                expect(env[`${VAR}DB`]).toMatch(/^postgres:\/\/postgres:postgres@127\.0\.0\.1:\d+\/postgres$/u);
                expect(existsSync(join(root, ".wrangler", "state", "lunora-pglite", "DB"))).toBe(true);
            } finally {
                await local?.stop();
            }
        });
    });
});
