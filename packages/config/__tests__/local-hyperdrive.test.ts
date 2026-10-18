import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PgliteParts, PgliteRuntime } from "../src/cloudflare/local-hyperdrive";
import { bindingsNeedingDatabase, serveDatabase, startLocalHyperdrive } from "../src/cloudflare/local-hyperdrive";

const VAR = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_";
const UNAVAILABLE = "postgres://postgres:postgres@127.0.0.1:1/postgres"; // gitleaks:allow -- a placeholder that connects to nothing

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

        it("reads a named environment's own Hyperdrive array, since the binding does not inherit", () => {
            expect.assertions(3);

            writeFileSync(
                join(root, "wrangler.jsonc"),
                JSON.stringify({ env: { staging: { hyperdrive: [{ binding: "STAGING_DB", id: "s" }] } }, hyperdrive: [{ binding: "DB", id: "a" }] }),
                "utf8",
            );

            expect(bindingsNeedingDatabase(root, {}, "staging")).toStrictEqual(["STAGING_DB"]);
            expect(bindingsNeedingDatabase(root, { CLOUDFLARE_ENV: "staging" })).toStrictEqual(["STAGING_DB"]);
            expect(bindingsNeedingDatabase(root, {})).toStrictEqual(["DB"]);
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

        it("says how to install PGlite, and still lets dev start on an address that refuses connections, when it is missing", async () => {
            expect.assertions(5);

            writeWrangler([{ binding: "DB", id: "a" }]);

            const env: NodeJS.ProcessEnv = {};
            const warnings: string[] = [];
            const local = await startLocalHyperdrive({ env, load: async () => undefined, onWarning: (line) => warnings.push(line), projectRoot: root });

            expect(warnings.join(" ")).toContain("pnpm add -D @electric-sql/pglite @electric-sql/pglite-socket");
            expect(warnings.join(" ")).toContain("will fail to connect");
            expect(env[`${VAR}DB`]).toBe(UNAVAILABLE);
            expect(local?.bindings).toStrictEqual([]);

            await local?.stop();

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

            const local = await startLocalHyperdrive({ env, load: async () => runtime, onWarning: (line) => warnings.push(line), projectRoot: root });

            expect(local?.bindings).toStrictEqual([]);

            const envAfterFailure = { ...env };

            // The caller's stop after the failure path's own release stops nothing twice.
            await local?.stop();

            expect(stops).toStrictEqual(["DB_A"]);
            expect({ env: envAfterFailure, warnings: warnings.join(" ").includes("boom") }).toStrictEqual({
                env: { [`${VAR}DB_A`]: UNAVAILABLE, [`${VAR}DB_B`]: UNAVAILABLE },
                warnings: true,
            });
        });

        it("leaves a data directory alone while another live process has it open, and says which", async () => {
            expect.assertions(4);

            writeWrangler([{ binding: "DB", id: "a" }]);

            const lock = join(root, ".wrangler", "state", "lunora-pglite", "DB.lock");

            mkdirSync(join(root, ".wrangler", "state", "lunora-pglite"), { recursive: true });
            // The parent of this test process is alive, and not us.
            writeFileSync(lock, String(process.ppid), "utf8");

            const { directories, runtime } = fakeRuntime();
            const env: NodeJS.ProcessEnv = {};
            const warnings: string[] = [];

            const local = await startLocalHyperdrive({ env, load: async () => runtime, onWarning: (line) => warnings.push(line), projectRoot: root });

            expect(local?.bindings).toStrictEqual([]);
            expect(directories).toStrictEqual([]);
            // wrangler still starts: the binding gets an address that refuses connections.
            expect(env[`${VAR}DB`]).toBe(UNAVAILABLE);
            expect(warnings.join(" ")).toContain(`pid ${String(process.ppid)}`);
        });

        it("takes over a lock left by a process that has gone, and releases it on stop", async () => {
            expect.assertions(3);

            writeWrangler([{ binding: "DB", id: "a" }]);

            const lock = join(root, ".wrangler", "state", "lunora-pglite", "DB.lock");

            mkdirSync(join(root, ".wrangler", "state", "lunora-pglite"), { recursive: true });
            writeFileSync(lock, "2147483646", "utf8");

            const { runtime } = fakeRuntime();
            const local = await startLocalHyperdrive({ env: {}, load: async () => runtime, projectRoot: root });

            expect(readFileSync(lock, "utf8")).toBe(String(process.pid));

            await local?.stop();

            expect(local?.bindings).toStrictEqual(["DB"]);
            expect(existsSync(lock)).toBe(false);
        });

        it("treats a lock this same process holds as live, and leaves it intact", async () => {
            expect.assertions(4);

            writeWrangler([{ binding: "DB", id: "a" }]);

            const lock = join(root, ".wrangler", "state", "lunora-pglite", "DB.lock");
            const first = fakeRuntime();
            const firstLocal = await startLocalHyperdrive({ env: {}, load: async () => first.runtime, projectRoot: root });
            const second = fakeRuntime();
            const secondEnv: NodeJS.ProcessEnv = {};
            const secondLocal = await startLocalHyperdrive({ env: secondEnv, load: async () => second.runtime, onWarning: () => {}, projectRoot: root });

            expect(second.directories).toStrictEqual([]);
            expect(secondEnv[`${VAR}DB`]).toBe(UNAVAILABLE);

            await secondLocal?.stop();

            // The second starter never owned the lock, so its stop cannot remove the first one's.
            expect(existsSync(lock)).toBe(true);

            await firstLocal?.stop();

            expect(existsSync(lock)).toBe(false);
        });

        it("respects a lock it cannot read, since its owner was never checked", async () => {
            expect.assertions(2);

            writeWrangler([{ binding: "DB", id: "a" }]);

            // A directory in the lock's place can't be read as a file (EISDIR), which is not "gone".
            mkdirSync(join(root, ".wrangler", "state", "lunora-pglite", "DB.lock"), { recursive: true });

            const { directories, runtime } = fakeRuntime();

            await startLocalHyperdrive({ env: {}, load: async () => runtime, onWarning: () => {}, projectRoot: root });

            expect(directories).toStrictEqual([]);
            expect(existsSync(join(root, ".wrangler", "state", "lunora-pglite", "DB.lock"))).toBe(true);
        });

        it("leaves no temporary lock file behind, whether the lock was taken or already held", async () => {
            expect.assertions(2);

            writeWrangler([{ binding: "DB", id: "a" }]);

            const directory = join(root, ".wrangler", "state", "lunora-pglite");
            const { runtime } = fakeRuntime();
            const local = await startLocalHyperdrive({ env: {}, load: async () => runtime, projectRoot: root });

            expect(readdirSync(directory).filter((name) => name.startsWith("DB.lock."))).toStrictEqual([]);

            await local?.stop();

            writeFileSync(join(directory, "DB.lock"), String(process.ppid), "utf8");
            await startLocalHyperdrive({ env: {}, load: async () => runtime, onWarning: () => {}, projectRoot: root });

            expect(readdirSync(directory).filter((name) => name.startsWith("DB.lock."))).toStrictEqual([]);
        });

        it("releases the lock when the server fails to start", async () => {
            expect.assertions(1);

            writeWrangler([{ binding: "DB", id: "a" }]);

            const runtime: PgliteRuntime = {
                createServer: async () => {
                    throw new Error("boom");
                },
            };

            await startLocalHyperdrive({ env: {}, load: async () => runtime, onWarning: () => {}, projectRoot: root });

            expect(existsSync(join(root, ".wrangler", "state", "lunora-pglite", "DB.lock"))).toBe(false);
        });

        it.each([
            ["mysql2 alone", { mysql2: "^3" }, true],
            ["mysql2 beside pg", { mysql2: "^3", pg: "^8" }, false],
            ["postgres.js", { postgres: "^3" }, false],
        ])("does not serve an embedded Postgres to a project whose driver is %s only when it is MySQL", async (_label, dependencies, mysqlOnly) => {
            expect.assertions(3);

            writeWrangler([{ binding: "DB", id: "a" }]);
            writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies }), "utf8");

            const { directories, runtime } = fakeRuntime();
            const env: NodeJS.ProcessEnv = {};
            const warnings: string[] = [];
            const local = await startLocalHyperdrive({ env, load: async () => runtime, onWarning: (line) => warnings.push(line), projectRoot: root });

            expect(directories.length === 0).toBe(mysqlOnly);
            expect(env[`${VAR}DB`] === UNAVAILABLE).toBe(mysqlOnly);
            expect(warnings.join(" ").includes("mysql2")).toBe(mysqlOnly);

            await local?.stop();
        });

        it("keeps a binding name from leaving the state directory", async () => {
            expect.assertions(3);

            writeWrangler([{ binding: "../../../escaped", id: "a" }]);

            const { directories, runtime } = fakeRuntime();
            const local = await startLocalHyperdrive({ env: {}, load: async () => runtime, projectRoot: root });
            const state = join(root, ".wrangler", "state", "lunora-pglite");

            expect(directories).toHaveLength(1);
            expect(directories[0]?.startsWith(`${state}/`)).toBe(true);
            expect(existsSync(join(root, "..", "escaped"))).toBe(false);

            await local?.stop();
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

    describe(serveDatabase, () => {
        const parts = (start: () => Promise<void>, close: () => Promise<void>, stop: () => Promise<void>): PgliteParts => {
            return {
                PGLiteSocketServer: function PGLiteSocketServer() {
                    return { getServerConn: () => "127.0.0.1:5999", start, stop };
                } as unknown as PgliteParts["PGLiteSocketServer"],
                PGlite: {
                    create: async () => {
                        return { close };
                    },
                },
            };
        };

        it("closes the database it opened, and rethrows, when the socket cannot start", async () => {
            expect.assertions(3);

            const close = vi.fn<() => Promise<void>>(async () => {});
            const stop = vi.fn<() => Promise<void>>(async () => {});
            const start = async (): Promise<void> => {
                throw new Error("EADDRINUSE");
            };

            await expect(serveDatabase(parts(start, close, stop), join(root, "data"))).rejects.toThrow("EADDRINUSE");

            expect(close).toHaveBeenCalledTimes(1);
            expect(stop).toHaveBeenCalledTimes(1);
        });

        it("closes the database even when the socket's shutdown fails", async () => {
            expect.assertions(2);

            const close = vi.fn<() => Promise<void>>(async () => {});
            const stop = async (): Promise<void> => {
                throw new Error("socket stuck");
            };
            const served = await serveDatabase(
                parts(async () => {}, close, stop),
                join(root, "data"),
            );

            await expect(served.stop()).rejects.toThrow("socket stuck");

            expect(close).toHaveBeenCalledTimes(1);
        });

        it("returns a loopback connection string whose stop closes both the socket and the database", async () => {
            expect.assertions(3);

            const close = vi.fn<() => Promise<void>>(async () => {});
            const stop = vi.fn<() => Promise<void>>(async () => {});
            const served = await serveDatabase(
                parts(async () => {}, close, stop),
                join(root, "data"),
            );

            expect(served.connectionString).toBe("postgres://postgres:postgres@127.0.0.1:5999/postgres"); // gitleaks:allow -- a placeholder URL on a test double, not a real secret

            await served.stop();

            expect(stop).toHaveBeenCalledTimes(1);
            expect(close).toHaveBeenCalledTimes(1);
        });
    });
});
