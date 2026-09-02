import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readDevServerState, writeDevServerState } from "@lunora/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DevCommandOptions } from "../../src/commands/dev/handler";
import { defaultWorkerSpawner, detectDevFlavor, planDevCommand, resolveWorkerPort, runDevCommand } from "../../src/commands/dev/handler";
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
        // Unconditional: a failed assertion would skip a trailing unstub in a test
        // body, leaking LUNORA_CODEGEN into every test that follows.
        vi.unstubAllEnvs();
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

        it("plans an attached run with --no-worker, keeping codegen + studio", () => {
            expect.assertions(4);

            // `lunora dev` assumed it owned the dev process,
            // so a repo whose task runner already supervises seven workers had
            // no way to run the Lunora one as a node in that graph. Attached
            // mode keeps the parts only Lunora can provide and drops the spawn.
            const plan = planDevCommand({ cwd: workdir, logger: silentLogger(), worker: false });

            expect(plan.workerEnabled).toBe(false);
            expect(plan.runsCodegenWatch).toBe(true);
            expect(plan.studioEnabled).toBe(true);
            // The plan still records where the externally-owned worker will be,
            // so studio and the printed hints point at the right origin.
            expect(plan.workerOrigin).toContain(String(plan.workerPort));
        });

        it("refuses --no-worker on the vite flavor instead of parking on nothing", () => {
            expect.assertions(3);

            // The gate lives on the shared run path, so a flavor-agnostic
            // `workerEnabled: false` would have suppressed the FRAMEWORK dev
            // server too — and the vite plan sets codegen and studio to false
            // because Vite runs them in-process. The process would have parked
            // having started literally nothing, while logging that codegen was
            // running.
            writeFileSync(join(workdir, "package.json"), JSON.stringify({ devDependencies: { "@lunora/vite": "^1.0.0" } }), "utf8");

            const messages: string[] = [];
            const logger = { ...silentLogger(), warn: (message: string) => messages.push(message) };
            const plan = planDevCommand({ cwd: workdir, logger, worker: false });

            expect(plan.flavor).toBe("vite");
            expect(plan.workerEnabled).toBe(true);
            expect(messages.some((message) => message.includes("--no-worker does not apply"))).toBe(true);
        });

        it("keeps the worker enabled by default", () => {
            expect.assertions(1);

            expect(planDevCommand({ cwd: workdir, logger: silentLogger() }).workerEnabled).toBe(true);
        });

        it("adds a framework redirect hint (wrangler plan unchanged) in a Vite project", () => {
            expect.assertions(4);

            // A meta-framework project: `@lunora/vite` runs the worker inside Vite.
            writeFileSync(join(workdir, "package.json"), JSON.stringify({ devDependencies: { "@react-router/dev": "^7.0.0" } }), "utf8");

            const plan = planDevCommand({ cwd: workdir, logger: silentLogger() });

            expect(plan.frameworkHint).toContain("react-router");
            expect(plan.frameworkHint).toContain("lunora dev");
            // The wrangler spawn is unchanged — the hint never replaces it.
            expect(plan.wrangler.args.join(" ")).toContain("wrangler dev");
            expect(plan.wrangler.tag).toBe("wrangler");
        });

        it("adds no hint for a standalone project (no framework)", () => {
            expect.assertions(2);

            const plan = planDevCommand({ cwd: workdir, logger: silentLogger() });

            expect(plan.frameworkHint).toBeUndefined();
            expect(plan.wrangler.args.join(" ")).toContain("wrangler dev");
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

        it("pins the worker to 127.0.0.1 when the host has no IPv6 loopback", () => {
            expect.assertions(3);

            // Simulate a host without `::1`: workerd's default `[::1]` bind would
            // abort with `Cannot assign requested address` — so `--ip 127.0.0.1`.
            const plan = planDevCommand({ cwd: workdir, hasIpv6Loopback: () => false, logger: silentLogger() });

            expect(plan.wrangler.args.join(" ")).toContain("--ip 127.0.0.1");
            // Placed before `--var` so it applies to the same `wrangler dev` invocation.
            expect(plan.wrangler.args.join(" ")).toContain("wrangler dev --port");
            expect(plan.ipv4LoopbackForced).toBe(true);
        });

        it("leaves wrangler's default bind when the host has IPv6 loopback", () => {
            expect.assertions(2);

            const plan = planDevCommand({ cwd: workdir, hasIpv6Loopback: () => true, logger: silentLogger() });

            expect(plan.wrangler.args).not.toContain("--ip");
            expect(plan.ipv4LoopbackForced).toBe(false);
        });

        it("respects an explicit `dev.ip` in wrangler config over the loopback auto-detect", () => {
            expect.assertions(2);

            // The user pinned their own bind — the auto `--ip 127.0.0.1` must not
            // override it, even on a host without IPv6 loopback.
            writeFileSync(join(workdir, "wrangler.jsonc"), JSON.stringify({ dev: { ip: "0.0.0.0" }, name: "app" }), "utf8");

            const plan = planDevCommand({ cwd: workdir, hasIpv6Loopback: () => false, logger: silentLogger() });

            expect(plan.wrangler.args).not.toContain("--ip");
            expect(plan.ipv4LoopbackForced).toBe(false);
        });

        it("reflects the --no-studio / --no-codegen toggles", () => {
            expect.assertions(2);

            const plan = planDevCommand({ codegen: false, cwd: workdir, studio: false, logger: silentLogger() });

            expect(plan.studioEnabled).toBe(false);
            expect(plan.runsCodegenWatch).toBe(false);
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

        it("plans `vite dev` for a project on @lunora/vite (flavor: vite)", () => {
            expect.assertions(6);

            writeFileSync(join(workdir, "package.json"), JSON.stringify({ devDependencies: { "@lunora/vite": "workspace:*" }, name: "app" }), "utf8");

            expect(detectDevFlavor(workdir)).toBe("vite");

            const plan = planDevCommand({ cwd: workdir, logger: silentLogger() });

            expect(plan.flavor).toBe("vite");
            expect(plan.wrangler.tag).toBe("vite");
            expect(plan.wrangler.args.join(" ")).toContain("vite dev");
            // The Vite plugin already runs studio + codegen inside the dev server.
            expect(plan.studioEnabled).toBe(false);
            expect(plan.runsCodegenWatch).toBe(false);
        });

        it("runs the project's dev script for the vite flavor (meta-framework CLIs)", () => {
            expect.assertions(3);

            // An Astro project: bare `vite dev` cannot boot it — the dev script
            // (`astro dev`) is the source of truth for the dev server command.
            writeFileSync(
                join(workdir, "package.json"),
                JSON.stringify({
                    devDependencies: { "@lunora/vite": "workspace:*" },
                    name: "app",
                    packageManager: "pnpm@11.0.0",
                    scripts: { dev: "astro dev" },
                }),
                "utf8",
            );

            const plan = planDevCommand({ cwd: workdir, logger: silentLogger() });

            expect(plan.wrangler.tag).toBe("vite");
            expect(plan.wrangler.command).toBe("pnpm");
            expect(plan.wrangler.args).toStrictEqual(["run", "dev"]);
        });

        it("falls back to `vite dev` when the dev script would re-enter lunora", () => {
            expect.assertions(1);

            // `scripts.dev: "lunora dev"` + the vite flavor would spawn this CLI
            // forever — the guard falls back to the direct vite exec instead.
            writeFileSync(
                join(workdir, "package.json"),
                JSON.stringify({
                    devDependencies: { "@lunora/vite": "workspace:*" },
                    name: "app",
                    scripts: { dev: "lunora dev" },
                }),
                "utf8",
            );

            const plan = planDevCommand({ cwd: workdir, logger: silentLogger() });

            expect(plan.wrangler.args.join(" ")).toContain("vite dev");
        });

        it("forwards remote mode to the vite child as LUNORA_REMOTE env", () => {
            expect.assertions(2);

            const plan = planDevCommand({ cwd: workdir, flavor: "vite", logger: silentLogger(), remote: true });

            expect(plan.wrangler.env).toStrictEqual({ LUNORA_REMOTE: "1" });
            expect(plan.remote.enabled).toBe(true);
        });

        it("honours LUNORA_CODEGEN=0 on the wrangler flavor too, where the CLI owns the watcher", () => {
            expect.assertions(2);

            // The env var is documented as the flag's other spelling. The CLI's own
            // watcher read only `options.codegen`, so on the flavor where the CLI —
            // not the plugin — owns codegen, setting it did nothing at all.
            vi.stubEnv("LUNORA_CODEGEN", "0");

            expect(planDevCommand({ cwd: workdir, flavor: "wrangler", logger: silentLogger() }).runsCodegenWatch).toBe(false);

            vi.unstubAllEnvs();

            expect(planDevCommand({ cwd: workdir, flavor: "wrangler", logger: silentLogger() }).runsCodegenWatch).toBe(true);
        });

        it("forwards --no-codegen to the vite child as LUNORA_CODEGEN=0", () => {
            expect.assertions(3);

            // On this flavor `@lunora/vite` owns the codegen watch, inside a child
            // process that re-parses its own argv — so `codegenEnabled: false`
            // alone left the flag inert and `_generated/**` kept being rewritten
            // on every save.
            const plan = planDevCommand({ codegen: false, cwd: workdir, flavor: "vite", logger: silentLogger() });

            expect(plan.wrangler.env).toStrictEqual({ LUNORA_CODEGEN: "0" });
            expect(plan.runsCodegenWatch).toBe(false);

            const enabled = planDevCommand({ cwd: workdir, flavor: "vite", logger: silentLogger() });

            expect(enabled.wrangler.env).toBeUndefined();
        });

        it.each([
            ["sveltekit", { "@sveltejs/kit": "^2.0.0" }],
            ["nuxt", { nuxt: "^4.0.0" }],
        ])("plans the two-process framework-worker stack for %s (front-door dev + wrangler sidecar)", (_name, dependencies) => {
            expect.assertions(7);

            // Class-B frameworks whose dev server can't host ShardDO. They also
            // declare `@lunora/vite` (their dev server uses it for codegen), but
            // the framework check wins so the flavor is `framework-worker`.
            writeFileSync(
                join(workdir, "package.json"),
                JSON.stringify({
                    dependencies,
                    devDependencies: { "@lunora/vite": "workspace:*" },
                    name: "app",
                    packageManager: "pnpm@11.0.0",
                    scripts: { dev: "vite" },
                }),
                "utf8",
            );

            expect(detectDevFlavor(workdir)).toBe("framework-worker");

            const plan = planDevCommand({ cwd: workdir, hasIpv6Loopback: () => true, logger: silentLogger() });

            expect(plan.flavor).toBe("framework-worker");
            // Primary child = the framework's own dev server (front door + HMR).
            expect(plan.wrangler.tag).toBe("vite");
            // Sidecar = `wrangler dev` on the dev-only config, owning ShardDO.
            expect(plan.sidecar?.tag).toBe("worker");
            expect(plan.sidecar?.args.join(" ")).toContain("dev --config wrangler.dev.jsonc");
            // Codegen/studio are owned by the framework's own @lunora/vite plugin.
            expect(plan.runsCodegenWatch).toBe(false);
            expect(plan.studioEnabled).toBe(false);
        });

        it("respects the sidecar's OWN `dev.ip` (wrangler.dev.jsonc), not the deploy wrangler.jsonc, on a no-::1 host", () => {
            expect.assertions(2);

            // Class-B framework-worker setup: the sidecar actually runs
            // `wrangler dev --config wrangler.dev.jsonc`, so its loopback
            // override must be resolved from THAT file, not the deploy
            // `wrangler.jsonc` (whose `main` doesn't even exist in dev).
            writeFileSync(
                join(workdir, "package.json"),
                JSON.stringify({
                    dependencies: { "@sveltejs/kit": "^2.0.0" },
                    devDependencies: { "@lunora/vite": "workspace:*" },
                    name: "app",
                    packageManager: "pnpm@11.0.0",
                    scripts: { dev: "vite" },
                }),
                "utf8",
            );
            // The deploy config has no `dev.ip` pinned.
            writeFileSync(join(workdir, "wrangler.jsonc"), JSON.stringify({ main: "dist/worker.js", name: "app" }), "utf8");
            // The sidecar's OWN config pins its bind explicitly.
            writeFileSync(join(workdir, "wrangler.dev.jsonc"), JSON.stringify({ dev: { ip: "0.0.0.0" }, main: "lunora/server.ts", name: "app" }), "utf8");

            const plan = planDevCommand({ cwd: workdir, hasIpv6Loopback: () => false, logger: silentLogger() });

            // The user's own `dev.ip` in wrangler.dev.jsonc wins — the auto
            // `--ip 127.0.0.1` must not override it, even on a host with no
            // IPv6 loopback.
            expect(plan.sidecar?.args).not.toContain("--ip");
            expect(plan.sidecar?.args.join(" ")).not.toContain("127.0.0.1");
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

    describe("resolveWorkerPort", () => {
        it("uses an explicit worker port and never probes", async () => {
            expect.assertions(2);

            let probed = false;
            const port = await resolveWorkerPort(
                {
                    findFreePort: async () => {
                        probed = true;

                        return 9999;
                    },
                    logger: silentLogger(),
                    workerPort: 4000,
                },
                workdir,
            );

            expect(port).toBe(4000);
            expect(probed).toBe(false);
        });

        it("respects a `dev.port` pinned in the wrangler config over the free-port probe", async () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "wrangler.jsonc"), JSON.stringify({ dev: { port: 4321 }, name: "app" }), "utf8");

            const port = await resolveWorkerPort({ findFreePort: async () => 9999, logger: silentLogger() }, workdir);

            expect(port).toBe(4321);
        });

        it("falls back to a probed free port when nothing is pinned", async () => {
            expect.assertions(1);

            const port = await resolveWorkerPort({ findFreePort: async () => 8801, logger: silentLogger() }, workdir);

            expect(port).toBe(8801);
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
                // Deterministic port so the origin assertion below doesn't depend
                // on whether 8787 is free on the test host.
                findFreePort: async () => 8787,
                logger: silentLogger(),
                startCodegen: () => {
                    return {
                        close: async () => {
                            codegenClosed = true;
                        },
                        ready: Promise.resolve(),
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

        it("logs the framework redirect hint but still spawns the worker", async () => {
            expect.assertions(3);

            // A class-A framework WITHOUT `@lunora/vite` still takes the wrangler
            // flavor (the worker runs inside the framework's own Vite dev server,
            // so `lunora dev` gives just the worker + a redirect hint). SvelteKit /
            // Nuxt are class-B and take the two-process `framework-worker` flavor
            // instead — covered separately below.
            writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies: { "@tanstack/react-start": "^1.0.0" } }), "utf8");

            const warnings: string[] = [];
            let workerSpawned = false;

            const result = await runDevCommand({
                cwd: workdir,
                logger: { ...silentLogger(), warn: (message) => warnings.push(message) },
                startCodegen: () => {
                    return { close: async () => {}, ready: Promise.resolve(), watchAvailable: true };
                },
                startStudio: async () => {
                    return { close: async () => {}, url: "http://127.0.0.1:6173" };
                },
                startWorker: () => {
                    workerSpawned = true;

                    return { exited: Promise.resolve(0), kill: () => {} };
                },
                studio: false,
            });

            expect(result.code).toBe(0);
            expect(workerSpawned).toBe(true);
            expect(warnings.some((line) => line.includes("tanstack-start") && line.includes("lunora dev"))).toBe(true);
        });

        it("framework-worker: spawns the framework dev server + wrangler sidecar and tears the sidecar down on exit", async () => {
            expect.assertions(4);

            // SvelteKit (class-B): two-process dev — the framework's own dev
            // server (front door) + a `wrangler dev` sidecar owning ShardDO.
            writeFileSync(
                join(workdir, "package.json"),
                JSON.stringify({
                    dependencies: { "@sveltejs/kit": "^2.0.0" },
                    devDependencies: { "@lunora/vite": "workspace:*" },
                    name: "app",
                    packageManager: "pnpm@11.0.0",
                    scripts: { dev: "vite" },
                }),
                "utf8",
            );

            const spawned: string[] = [];
            let sidecarKilled = false;
            let resolveSidecar: (code: number) => void = () => {};
            const sidecarExited = new Promise<number>((resolve) => {
                resolveSidecar = resolve;
            });

            const startWorker: NonNullable<DevCommandOptions["startWorker"]> = (descriptor) => {
                spawned.push(descriptor.tag);

                // The sidecar runs until killed; killing it resolves its exit so
                // the orchestrator's `allSettled` teardown can complete.
                if (descriptor.tag === "worker") {
                    return {
                        exited: sidecarExited,
                        kill: () => {
                            sidecarKilled = true;
                            resolveSidecar(0);
                        },
                    };
                }

                // The framework dev server (primary) exits cleanly straight away.
                return { exited: Promise.resolve(0), kill: () => {} };
            };

            const result = await runDevCommand({ cwd: workdir, logger: silentLogger(), startWorker });

            expect(result.code).toBe(0);
            expect(spawned).toContain("vite"); // framework dev server (front door)
            expect(spawned).toContain("worker"); // wrangler sidecar (ShardDO)
            expect(sidecarKilled).toBe(true); // primary exit tore the sidecar down
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
                    return { close: async () => {}, ready: Promise.resolve(), watchAvailable: true };
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
                    return { close: async () => {}, ready: Promise.resolve(), watchAvailable: true };
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

        it("records the running server in .lunora/dev.json and clears it on exit", async () => {
            expect.assertions(4);

            let resolveExit: (code: number) => void = () => {};
            const exited = new Promise<number>((resolve) => {
                resolveExit = resolve;
            });

            const runPromise = runDevCommand({
                cwd: workdir,
                // Deterministic port so the recorded URL assertion is host-independent.
                findFreePort: async () => 8787,
                logger: silentLogger(),
                startCodegen: () => {
                    return { close: async () => {}, ready: Promise.resolve(), watchAvailable: true };
                },
                startStudio: async () => {
                    return { close: async () => {}, url: "http://127.0.0.1:6173" };
                },
                startWorker: () => {
                    return { exited, kill: () => {} };
                },
            });

            // Let startup complete (scaffold offer + spawn + state write).
            await new Promise((resolve) => {
                setTimeout(resolve, 25);
            });

            const state = readDevServerState(workdir);

            expect(state?.pid).toBe(process.pid);
            expect(state?.url).toBe("http://localhost:8787");
            expect(state?.mode).toBe("cli");

            resolveExit(0);
            await runPromise;

            // The record is cleared on shutdown.
            expect(readDevServerState(workdir)).toBeUndefined();
        });

        it("claims a provisional record for the vite flavor and hands off via env", async () => {
            expect.assertions(4);

            writeFileSync(join(workdir, "package.json"), JSON.stringify({ devDependencies: { "@lunora/vite": "workspace:*" }, name: "app" }), "utf8");

            let resolveExit: (code: number) => void = () => {};
            const exited = new Promise<number>((resolve) => {
                resolveExit = resolve;
            });
            let childEnvironment: Record<string, string> | undefined;

            const runPromise = runDevCommand({
                cwd: workdir,
                logger: silentLogger(),
                startWorker: (descriptor) => {
                    childEnvironment = descriptor.env ? { ...descriptor.env } : undefined;

                    return { exited, kill: () => {} };
                },
            });

            // Let startup complete (claim + scaffold offer + spawn).
            await new Promise((resolve) => {
                setTimeout(resolve, 25);
            });

            // The provisional record carries this CLI's pid until the vite
            // dev-state plugin (in the child) supersedes it.
            const state = readDevServerState(workdir);

            expect(state?.pid).toBe(process.pid);
            expect(state?.url).toBe("http://localhost:5173");
            // The handoff env names the record the plugin may supersede.
            expect(childEnvironment?.LUNORA_DEV_HANDOFF_PID).toBe(String(process.pid));

            resolveExit(0);
            await runPromise;

            // The provisional record is cleared on shutdown.
            expect(readDevServerState(workdir)).toBeUndefined();
        });

        it("reports an already-running dev server instead of double-starting (lockfile)", async () => {
            expect.assertions(3);

            // A live record owned by another process (the test runner's parent).
            writeDevServerState(workdir, { mode: "cli", pid: process.ppid, url: "http://localhost:8787" });

            let spawned = false;
            const warns: string[] = [];
            const logger: Logger = {
                error: () => {},
                info: () => {},
                success: () => {},
                warn: (message) => warns.push(message),
            };

            const result = await runDevCommand({
                cwd: workdir,
                logger,
                startWorker: () => {
                    spawned = true;

                    return { exited: Promise.resolve(0), kill: () => {} };
                },
            });

            expect(result.code).toBe(0);
            expect(spawned).toBe(false);
            expect(warns.some((line) => line.includes("already running"))).toBe(true);
        });

        it("supersedes the background parent's provisional record (does not self-detect as already-running)", async () => {
            expect.assertions(3);

            // The auto-background daemon inherits DEV_HANDOFF_PID = its parent's
            // PID, and that parent wrote a provisional record (its own, live PID)
            // before spawning the daemon. The daemon must claim OVER it and start,
            // not report "already running" and bail — which is how `lunora dev`
            // launches under AI-agent auto-background. Use `process.ppid` as the
            // live "parent" PID (the same trick as the lockfile test above).
            writeDevServerState(workdir, { mode: "cli", pid: process.ppid, url: "http://localhost:5173" });
            const previous = process.env.LUNORA_DEV_HANDOFF_PID;
            process.env.LUNORA_DEV_HANDOFF_PID = String(process.ppid);

            let spawned = false;
            const warns: string[] = [];
            const logger: Logger = { error: () => {}, info: () => {}, success: () => {}, warn: (message) => warns.push(message) };

            try {
                const result = await runDevCommand({
                    codegen: false,
                    cwd: workdir,
                    logger,
                    startWorker: () => {
                        spawned = true;

                        return { exited: Promise.resolve(0), kill: () => {} };
                    },
                    studio: false,
                });

                expect(result.code).toBe(0);
                expect(spawned).toBe(true); // claimed over the parent's provisional record and started
                expect(warns.some((line) => line.includes("already running"))).toBe(false);
            } finally {
                if (previous === undefined) {
                    delete process.env.LUNORA_DEV_HANDOFF_PID;
                } else {
                    process.env.LUNORA_DEV_HANDOFF_PID = previous;
                }
            }
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
                    return { close: async () => {}, ready: Promise.resolve(), watchAvailable: true };
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

    describe("--emit-bindings", () => {
        /**
         * The other half of "Lunora is one participant, not the session":
         * `build --emit-bindings` tells a deployer what to provision, and this
         * tells a task runner the same thing plus where the running server is,
         * so a multi-worker repo stops restating both in a config that drifts.
         */
        const runWithManifest = async (destination: string | undefined): Promise<number | undefined> => {
            const result = await runDevCommand({
                cwd: workdir,
                ...(destination === undefined ? {} : { emitBindings: destination }),
                findFreePort: async () => 8787,
                logger: silentLogger(),
                probeReady: async () => true,
                startCodegen: () => {
                    return { close: async () => {}, ready: Promise.resolve(), watchAvailable: true };
                },
                startWorker: () => {
                    return { exited: Promise.resolve(0), kill: () => {} };
                },
                studio: false,
            });

            return result.code;
        };

        it("writes the requirements plus where the dev server serves", async () => {
            expect.assertions(3);

            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                JSON.stringify({
                    compatibility_date: "2026-01-01",
                    d1_databases: [{ binding: "DB", database_name: "app" }],
                    main: "src/index.ts",
                    name: "app",
                }),
                "utf8",
            );

            const destination = join(workdir, "dev-manifest.json");

            await runWithManifest(destination);

            const manifest = JSON.parse(readFileSync(destination, "utf8")) as {
                bindings: { binding: string }[];
                dev?: { origin: string; statusFile: string };
            };

            expect(manifest.bindings.map((binding) => binding.binding)).toContain("DB");
            expect(manifest.dev?.origin).toBe("http://localhost:8787");
            // Named, not inlined: the manifest is written before readiness is
            // known, so it points at the record that carries it.
            expect(manifest.dev?.statusFile).toContain("dev.json");
        });

        it("omits the origin on the vite flavor rather than publishing a guess", async () => {
            expect.assertions(2);

            // Vite resolves its own port, possibly after this file is written, so
            // the plan's `workerOrigin` is a pre-listen default there. Emitting it
            // would aim a supervisor's proxy at a port nothing is listening on —
            // `statusFile` carries the real URL once Vite records it.
            writeFileSync(join(workdir, "wrangler.jsonc"), JSON.stringify({ compatibility_date: "2026-01-01", main: "src/index.ts", name: "app" }), "utf8");

            const destination = join(workdir, "dev-manifest.json");

            await runDevCommand({
                cwd: workdir,
                emitBindings: destination,
                flavor: "vite",
                logger: silentLogger(),
                startCodegen: () => {
                    return { close: async () => {}, ready: Promise.resolve(), watchAvailable: true };
                },
                startWorker: () => {
                    return { exited: Promise.resolve(0), kill: () => {} };
                },
                studio: false,
            });

            const manifest = JSON.parse(readFileSync(destination, "utf8")) as { dev?: { origin?: string; statusFile: string } };

            expect(manifest.dev?.origin).toBeUndefined();
            expect(manifest.dev?.statusFile).toContain("dev.json");
        });

        it("fails the run when a NAMED destination cannot be derived", async () => {
            expect.assertions(2);

            // An empty requirements document reads as "this Worker needs
            // nothing", and a supervisor acting on it provisions nothing — worse
            // than no file, because it looks authoritative. Naming a path means
            // something is waiting on it, so this is fatal.
            const destination = join(workdir, "dev-manifest.json");
            const code = await runWithManifest(destination);

            expect(code).toBe(1);
            expect(existsSync(destination)).toBe(false);
        });

        it("writes the manifest with no flag at all", async () => {
            expect.assertions(2);

            // The flag had to be discovered before it could help, and a
            // supervisor that never finds it hand-maintains a second copy of
            // these bindings. The file carries no secrets (vars are key names)
            // and lands in the already-gitignored `.lunora/`, same as dev.json.
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                JSON.stringify({
                    compatibility_date: "2026-01-01",
                    d1_databases: [{ binding: "DB", database_name: "app" }],
                    main: "src/index.ts",
                    name: "app",
                }),
                "utf8",
            );

            await runWithManifest(undefined);

            const manifest = JSON.parse(readFileSync(join(workdir, ".lunora", "dev-bindings.json"), "utf8")) as {
                bindings: { binding: string }[];
                dev?: { origin?: string };
            };

            expect(manifest.bindings.map((binding) => binding.binding)).toContain("DB");
            expect(manifest.dev?.origin).toBe("http://localhost:8787");
        });

        it("advertises the manifest in the banner only when one was written", async () => {
            expect.assertions(2);

            // A default nobody is told about helps nobody — that was the whole
            // reason for defaulting it. But naming a path that does not exist is
            // worse than saying nothing, so a project with no wrangler config
            // must not get the line.
            const withConfig: string[] = [];

            writeFileSync(join(workdir, "wrangler.jsonc"), JSON.stringify({ compatibility_date: "2026-01-01", main: "src/index.ts", name: "app" }), "utf8");
            await runDevCommand({
                cwd: workdir,
                findFreePort: async () => 8787,
                logger: { ...silentLogger(), info: (message: string) => withConfig.push(message) },
                probeReady: async () => true,
                startCodegen: () => {
                    return { close: async () => {}, ready: Promise.resolve(), watchAvailable: true };
                },
                startWorker: () => {
                    return { exited: Promise.resolve(0), kill: () => {} };
                },
                studio: false,
            });

            expect(withConfig.join("\n")).toContain("dev-bindings.json");

            rmSync(join(workdir, "wrangler.jsonc"));
            rmSync(join(workdir, ".lunora"), { force: true, recursive: true });

            const withoutConfig: string[] = [];

            await runDevCommand({
                cwd: workdir,
                findFreePort: async () => 8787,
                logger: { ...silentLogger(), info: (message: string) => withoutConfig.push(message) },
                probeReady: async () => true,
                startCodegen: () => {
                    return { close: async () => {}, ready: Promise.resolve(), watchAvailable: true };
                },
                startWorker: () => {
                    return { exited: Promise.resolve(0), kill: () => {} };
                },
                studio: false,
            });

            expect(withoutConfig.join("\n")).not.toContain("dev-bindings.json");
        });

        it("does not fail a project that has no wrangler config when nobody asked", async () => {
            expect.assertions(2);

            // Defaulting the hard error would break every project without a
            // wrangler config. Unasked, the manifest is a courtesy.
            const code = await runWithManifest(undefined);

            expect(code).toBe(0);
            expect(existsSync(join(workdir, ".lunora", "dev-bindings.json"))).toBe(false);
        });
    });

    describe("readiness probe wiring", () => {
        /**
         * Which flavors get a `readyAt` stamp from the CLI, and which delegate.
         *
         * This is the test whose absence let `--no-worker` ship without one: the
         * probe was started after the attached-mode early return, so the flavor
         * whose entire purpose is being supervised externally reported "starting"
         * forever, and the poll loop in the monorepo docs never terminated.
         */
        const runWithProbe = async (overrides: Partial<DevCommandOptions>): Promise<{ origins: string[] }> => {
            const origins: string[] = [];

            await runDevCommand({
                cwd: workdir,
                findFreePort: async () => 8787,
                logger: silentLogger(),
                probeReady: async (origin) => {
                    origins.push(origin);

                    return true;
                },
                startCodegen: () => {
                    return { close: async () => {}, ready: Promise.resolve(), watchAvailable: true };
                },
                startWorker: () => {
                    return { exited: Promise.resolve(0), kill: () => {} };
                },
                studio: false,
                ...overrides,
            });

            return { origins };
        };

        it("probes the worker origin on the wrangler flavor", async () => {
            expect.assertions(1);

            const { origins } = await runWithProbe({ flavor: "wrangler" });

            expect(origins).toContain("http://localhost:8787");
        });

        it("does not probe a managed worker before it has been spawned", async () => {
            expect.assertions(1);

            // The probe cannot tell OUR worker from anything else already
            // listening on that origin. Started before the spawn, a stale server
            // or an unrelated process holding the port answers immediately,
            // `readyAt` is stamped for it, and every dependent task is pointed at
            // the wrong server while wrangler is still failing to bind.
            const order: string[] = [];

            await runDevCommand({
                cwd: workdir,
                findFreePort: async () => 8787,
                logger: silentLogger(),
                probeReady: async () => {
                    order.push("probe");

                    return true;
                },
                startCodegen: () => {
                    return { close: async () => {}, ready: Promise.resolve(), watchAvailable: true };
                },
                startWorker: () => {
                    order.push("spawn");

                    return { exited: Promise.resolve(0), kill: () => {} };
                },
                studio: false,
            });

            expect(order.indexOf("spawn")).toBeLessThan(order.indexOf("probe"));
        });

        it("probes under --no-worker, where an external runner owns the worker", async () => {
            expect.assertions(1);

            // `--no-worker` parks the process without spawning wrangler, but this
            // process still owns `.lunora/dev.json` — so it still owes a
            // readiness answer about the origin it recorded.
            const { origins } = await runWithProbe({
                flavor: "wrangler",
                // Attached mode parks until interrupted; end it immediately so the
                // test observes what was wired before the park, not a hang.
                waitForInterrupt: async () => 0,
                worker: false,
            });

            expect(origins).toContain("http://localhost:8787");
        });

        it("does not probe on the vite flavor — the plugin writes the authoritative record", async () => {
            expect.assertions(1);

            // `workerOrigin` is a pre-listen guess there (Vite picks its own
            // port), so probing it would stamp readiness for the wrong origin.
            const { origins } = await runWithProbe({ flavor: "vite" });

            expect(origins).toHaveLength(0);
        });
    });

    describe("defaultWorkerSpawner", () => {
        it("reports a signal-killed worker as a failure, not exit 0", async () => {
            expect.assertions(1);

            const worker = defaultWorkerSpawner(
                { args: ["-e", "process.kill(process.pid, 'SIGKILL')"], command: process.execPath, cwd: workdir, tag: "wrangler" },
                silentLogger(),
            );

            await expect(worker.exited).resolves.toBe(1);
        });

        it("passes a real exit code through", async () => {
            expect.assertions(1);

            const worker = defaultWorkerSpawner({ args: ["-e", "process.exit(0)"], command: process.execPath, cwd: workdir, tag: "wrangler" }, silentLogger());

            await expect(worker.exited).resolves.toBe(0);
        });
    });
});
