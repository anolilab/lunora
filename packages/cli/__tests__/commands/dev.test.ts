import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DevCommandOptions } from "../../src/commands/dev/handler";
import { planDevCommand, runDevCommand } from "../../src/commands/dev/handler";
import type { Logger } from "../../src/util/logger";

const silentLogger = (): Logger => {
    return {
        error: () => {},
        info: () => {},
        success: () => {},
        warn: () => {},
    };
};

let workdir: string;

describe("lunora dev", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-dev-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("planDevCommand", () => {
        it("plans a single `wrangler dev` child — never Vite", () => {
            expect.assertions(5);

            const plan = planDevCommand({ cwd: workdir, logger: silentLogger() });

            expect(plan.wrangler.tag).toBe("wrangler");
            expect(plan.wrangler.args.join(" ")).toContain("wrangler");
            expect(plan.wrangler.args.join(" ")).toContain("dev");
            expect(plan.wrangler.args.join(" ")).not.toContain("vite");
            expect(plan.studioEnabled).toBe(true);
        });

        it("flags the worker as a dev deployment via `--var WORKER_ENV:development`", () => {
            expect.assertions(1);

            const plan = planDevCommand({ cwd: workdir, logger: silentLogger() });

            // So the runtime streams every RPC dispatch summary in dev by default.
            expect(plan.wrangler.args.join(" ")).toContain("--var WORKER_ENV:development");
        });

        it("defaults the worker to :8787 and the studio to :6173", () => {
            expect.assertions(3);

            const plan = planDevCommand({ cwd: workdir, logger: silentLogger() });

            expect(plan.workerPort).toBe(8787);
            expect(plan.workerOrigin).toBe("http://localhost:8787");
            expect(plan.studioPort).toBe(6173);
        });

        it("routes the worker port into wrangler --port and the worker origin", () => {
            expect.assertions(3);

            const plan = planDevCommand({ cwd: workdir, logger: silentLogger(), port: 7000, workerPort: 9999 });

            expect(plan.wrangler.args).toContain("9999");
            expect(plan.workerOrigin).toBe("http://localhost:9999");
            expect(plan.studioPort).toBe(7000);
        });

        it("reflects the --no-studio / --no-codegen toggles", () => {
            expect.assertions(2);

            const plan = planDevCommand({ codegen: false, cwd: workdir, studio: false, logger: silentLogger() });

            expect(plan.studioEnabled).toBe(false);
            expect(plan.codegenEnabled).toBe(false);
        });

        it("leaves remote mode off and adds no --config when --remote is absent", () => {
            expect.assertions(3);

            const plan = planDevCommand({ cwd: workdir, logger: silentLogger() });

            expect(plan.remote.enabled).toBe(false);
            expect(plan.remote.bindings).toEqual([]);
            expect(plan.wrangler.args).not.toContain("--config");
        });

        it("appends `--config <temp>` and lists remoted bindings when --remote is on", () => {
            expect.assertions(4);

            const generatedConfig = join(workdir, "lunora-remote", "wrangler.remote.jsonc");
            const plan = planDevCommand({
                cwd: workdir,
                logger: silentLogger(),
                // Injected materializer stands in for the real temp-config writer.
                materializeRemote: () => {
                    return {
                        cleanup: () => {},
                        configPath: generatedConfig,
                        enabled: true,
                        remoteBindings: [
                            { binding: "DB", kind: "D1", path: [0], section: "d1_databases" },
                            { binding: "SEARCH", kind: "Vectorize", path: [0], section: "vectorize" },
                        ],
                    };
                },
                remote: true,
            });

            expect(plan.remote.enabled).toBe(true);
            expect(plan.remote.bindings).toEqual(["DB (D1)", "SEARCH (Vectorize)"]);
            expect(plan.wrangler.args).toContain("--config");
            expect(plan.wrangler.args).toContain(generatedConfig);
        });

        it("requests remote mode but adds no --config when nothing is eligible", () => {
            expect.assertions(3);

            const plan = planDevCommand({
                cwd: workdir,
                logger: silentLogger(),
                materializeRemote: () => {
                    return { cleanup: () => {}, enabled: true, reason: "no remote-eligible bindings to proxy", remoteBindings: [] };
                },
                remote: true,
            });

            expect(plan.remote.enabled).toBe(true);
            expect(plan.remote.reason).toContain("no remote-eligible bindings");
            expect(plan.wrangler.args).not.toContain("--config");
        });

        it("threads the materializer's cleanup disposer onto the remote plan", () => {
            expect.assertions(1);

            const cleanup = (): void => {};
            const plan = planDevCommand({
                cwd: workdir,
                logger: silentLogger(),
                materializeRemote: () => {
                    return { cleanup, configPath: join(workdir, "w.jsonc"), enabled: true, remoteBindings: [] };
                },
                remote: true,
            });

            expect(plan.remote.cleanup).toBe(cleanup);
        });
    });

    describe("runDevCommand", () => {
        it("spawns the wrangler worker, starts studio + codegen, and tears them down on exit", async () => {
            expect.assertions(6);

            let codegenClosed = false;
            let studioClosed = false;
            const startWorker: NonNullable<DevCommandOptions["startWorker"]> = (descriptor) => {
                // Assert we were handed the wrangler descriptor, then exit cleanly.
                expect(descriptor.args.join(" ")).toContain("wrangler");
                expect(descriptor.args.join(" ")).toContain("dev");

                return { exited: Promise.resolve(0), kill: () => {} };
            };

            const result = await runDevCommand({
                cwd: workdir,
                logger: silentLogger(),
                startCodegen: () => {
                    return {
                        close: () => {
                            codegenClosed = true;
                        },
                        watchAvailable: true,
                    };
                },
                startStudio: async () => {
                    return {
                        close: async () => {
                            studioClosed = true;
                        },
                        url: "http://127.0.0.1:6173",
                    };
                },
                startWorker,
            });

            expect(result.code).toBe(0);
            // Siblings started and were torn down when the worker exited.
            expect(codegenClosed).toBe(true);
            expect(studioClosed).toBe(true);
            expect(result.plan.workerOrigin).toBe("http://localhost:8787");
        });

        it("fills empty .dev.vars secrets + the admin token before the worker boots", async () => {
            expect.assertions(2);

            let filledCwd: string | undefined;

            const result = await runDevCommand({
                cwd: workdir,
                // fillSecrets seam: assert it runs against the project cwd during startup.
                fillSecrets: ({ cwd }) => {
                    filledCwd = cwd;

                    return { addedKeys: ["LUNORA_ADMIN_TOKEN"], filledKeys: [], status: "filled" };
                },
                logger: silentLogger(),
                startCodegen: () => {
                    return { close: () => {}, watchAvailable: true };
                },
                startStudio: async () => {
                    return { close: async () => {}, url: "http://127.0.0.1:6173" };
                },
                startWorker: () => {
                    return { exited: Promise.resolve(0), kill: () => {} };
                },
                studio: false,
            });

            // The filler ran against the project cwd, and the worker still booted.
            // (key/status behaviour is exercised in @lunora/config's fillDevSecrets tests.)
            expect(filledCwd).toBe(workdir);
            expect(result.code).toBe(0);
        });

        it("unlinks the materialized remote temp config when the worker exits", async () => {
            expect.assertions(1);

            let cleaned = false;

            await runDevCommand({
                cwd: workdir,
                logger: silentLogger(),
                // Stub the materializer so remote mode is "on" with a disposer we can observe.
                materializeRemote: () => {
                    return {
                        cleanup: () => {
                            cleaned = true;
                        },
                        configPath: join(workdir, "wrangler.remote.jsonc"),
                        enabled: true,
                        remoteBindings: [],
                    };
                },
                remote: true,
                startCodegen: () => {
                    return { close: () => {}, watchAvailable: true };
                },
                startStudio: async () => {
                    return { close: async () => {}, url: "http://127.0.0.1:6173" };
                },
                startWorker: () => {
                    return { exited: Promise.resolve(0), kill: () => {} };
                },
                studio: false,
            });

            // The remote disposer ran on the (clean) exit path.
            expect(cleaned).toBe(true);
        });

        it("still unlinks the remote temp config when startup throws", async () => {
            expect.assertions(2);

            let cleaned = false;

            await expect(
                runDevCommand({
                    cwd: workdir,
                    logger: silentLogger(),
                    // ensureEnv throwing models a startup failure before the worker spawns.
                    ensureEnv: async () => {
                        throw new Error("boom");
                    },
                    materializeRemote: () => {
                        return {
                            cleanup: () => {
                                cleaned = true;
                            },
                            configPath: join(workdir, "wrangler.remote.jsonc"),
                            enabled: true,
                            remoteBindings: [],
                        };
                    },
                    remote: true,
                    startWorker: () => {
                        return { exited: Promise.resolve(0), kill: () => {} };
                    },
                }),
            ).rejects.toThrow("boom");

            // The `finally` teardown ran the disposer despite the throw.
            expect(cleaned).toBe(true);
        });

        it("logs an actionable .dev.vars hint when the scaffolder is declined non-interactively", async () => {
            expect.assertions(2);

            const infos: string[] = [];
            const logger: Logger = {
                error: () => {},
                info: (message) => infos.push(message),
                success: () => {},
                warn: () => {},
            };

            await runDevCommand({
                cwd: workdir,
                // Simulate a non-interactive decline (CI path): ensureDevVariables resolved with
                // status "declined" (no example file generated the plan).
                ensureEnv: async () => {
                    return { addedKeys: [], generatedKeys: [], status: "declined" };
                },
                logger,
                startCodegen: () => {
                    return { close: () => {}, watchAvailable: true };
                },
                startStudio: async () => {
                    return { close: async () => {}, url: "http://127.0.0.1:6173" };
                },
                startWorker: () => {
                    return { exited: Promise.resolve(0), kill: () => {} };
                },
            });

            // The hint should appear (we pass the non-interactive signal via the injected ensureEnv
            // returning "declined"; isInteractive() is false in the test runner because stdin is not a TTY).
            const hintLogged = infos.some((line) => line.includes(".dev.vars") && line.includes("lunora dev"));

            expect(hintLogged).toBe(true);
            // The interactive path must not be blocked — worker still exited cleanly.
            expect(infos.some((line) => line.includes("hint:"))).toBe(true);
        });
    });
});
