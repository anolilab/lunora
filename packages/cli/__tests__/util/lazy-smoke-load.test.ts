import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { DevProcess, DevProcessOptions, DevProcessSpawner, DriverToolchain } from "@lunora/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import runLazySmokeLoad from "../../src/util/lazy-smoke-load";

const startDevProcess = vi.hoisted(() => vi.fn<(options: DevProcessOptions) => Promise<DevProcess>>());

const acceptsConnection = vi.hoisted(() => vi.fn<(port: number) => Promise<boolean>>(async () => false));

// Every probe sees the preferred port free, the way two runs do before either `wrangler` has bound it.
const findAvailablePort = vi.hoisted(() => vi.fn<(preferred: number) => Promise<number>>(async (preferred) => preferred));

vi.mock(import("@lunora/config"), async (importOriginal) => {
    return { ...(await importOriginal()), acceptsConnection, startDevProcess };
});

vi.mock(import("../../src/util/free-port"), async (importOriginal) => {
    return { ...(await importOriginal()), findAvailablePort };
});

const dev = vi.fn<(request: { extraArgs?: string[] }) => { args: string[]; tool: string }>((request) => {
    return { args: ["dev", ...(request.extraArgs ?? [])], tool: "wrangler" };
});
const toolchain = { dev, devServer: "workerd" } as unknown as DriverToolchain;
const logger = {
    error: vi.fn<(message: string) => void>(),
    info: vi.fn<(message: string) => void>(),
    success: vi.fn<(message: string) => void>(),
    warn: vi.fn<(message: string) => void>(),
};

/** A project the check can run against: a generated lazy registry, a Worker entry, and a wrangler config. */
const scaffoldProject = (dir: string): void => {
    mkdirSync(join(dir, "lunora", "_generated"), { recursive: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "lunora", "_generated", "functions.ts"), "export const loadAllFunctions = async () => ({ checked: 0, failures: [] });\n");
    writeFileSync(join(dir, "src", "index.ts"), "export default {};\n");
    writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify({ main: "src/index.ts", name: "app" }));
};

/** The run id the smoke entry was written with; the probe must echo it back. */
const runIdOf = (entryPath: string): string => /const runId = "([^"]+)"/u.exec(readFileSync(entryPath, "utf8"))?.[1] ?? "";

interface WorkerResult {
    checked?: number;
    failures?: unknown[];
    integrations?: { checked: number; failures: { message: string; specifier: string }[] };
}

/** The smoke Worker's answer to one probe step, the way the generated entry answers it. */
const answerStep = (url: string, result: WorkerResult, run: string | undefined): Response => {
    const { searchParams } = new URL(url);

    if (searchParams.get("step") === "functions") {
        return Response.json({ checked: result.checked, failures: result.failures, run });
    }

    const failure = result.integrations?.failures.find(({ specifier }) => specifier === searchParams.get("specifier"));

    return Response.json(searchParams.get("step") === "integration" && failure !== undefined ? { message: failure.message, run } : { run });
};

describe(runLazySmokeLoad, () => {
    let cwd: string;
    const stop = vi.fn<() => Promise<void>>(async () => {});

    /** Answers the probe as this run's Worker would: the result plus the run id of the entry written for the latest `wrangler dev`. */
    const respondWith = (body: WorkerResult): void => {
        vi.stubGlobal(
            "fetch",
            vi.fn<(url: string) => Promise<Response>>(async (url) => answerStep(url, body, runIdOf(resolve(cwd, dev.mock.lastCall?.[0].extraArgs?.[0] ?? "")))),
        );
    };
    const run = (overrides: Partial<Parameters<typeof runLazySmokeLoad>[0]> = {}) => runLazySmokeLoad({ cwd, logger, toolchain, ...overrides });

    beforeEach(() => {
        cwd = mkdtempSync(join(tmpdir(), "lunora-smoke-load-"));
        scaffoldProject(cwd);
        vi.clearAllMocks();
        acceptsConnection.mockResolvedValue(false);
        startDevProcess.mockResolvedValue({ crashed: new Promise(() => {}), stop });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        rmSync(cwd, { force: true, recursive: true });
    });

    /**
     * Two runs choose the same port. The first to bind owns it. A later run on that port either gets `ready` from
     * `startDevProcess` (it saw a listener, not its own child) or, with `losingWranglerExits`, a rejection because its
     * `wrangler` exited on the bind; `acceptsConnection` then reports the owner. Returns each run's result and the ports used.
     */
    const raceForOnePort = async (losingWranglerExits: boolean) => {
        const other = mkdtempSync(join(tmpdir(), "lunora-smoke-load-"));

        try {
            scaffoldProject(other);

            const owners = new Map<number, { body: WorkerResult; runId: string }>();
            const clean = { checked: 1, failures: [], integrations: { checked: 0, failures: [] } };
            const broken = { checked: 1, failures: [{ functionPath: "posts:list", message: "boom" }], integrations: { checked: 0, failures: [] } };

            startDevProcess.mockImplementation(async (options) => {
                if (!owners.has(options.port)) {
                    owners.set(options.port, {
                        body: options.cwd === other ? broken : clean,
                        runId: runIdOf(resolve(options.cwd, options.args.find((arg) => arg.endsWith("entry.ts")) ?? "")),
                    });
                } else if (losingWranglerExits) {
                    throw new Error("wrangler dev (smoke-load) exited with code 1 before it was ready");
                }

                return { crashed: new Promise(() => {}), stop };
            });
            acceptsConnection.mockImplementation(async (port) => owners.has(port));
            vi.stubGlobal(
                "fetch",
                vi.fn<(url: string) => Promise<Response>>(async (url) => {
                    const owner = owners.get(Number(new URL(url).port));

                    return answerStep(url, owner?.body ?? {}, owner?.runId);
                }),
            );

            const [ours, theirs] = await Promise.all([run(), run({ cwd: other })]);

            return { ours, ports: new Set(startDevProcess.mock.calls.map(([options]) => options.port)), theirs };
        } finally {
            rmSync(other, { force: true, recursive: true });
        }
    };

    it("does not read another run's Worker as its own when both pick the same port", async () => {
        expect.assertions(3);

        const { ours, ports, theirs } = await raceForOnePort(false);

        expect(ours).toBeUndefined();
        expect(theirs).toContain("boom");
        expect(ports.size).toBe(2);
    });

    it("retries on the next port when its wrangler exits because another run holds the port", async () => {
        expect.assertions(3);

        const { ours, ports, theirs } = await raceForOnePort(true);

        expect(ours).toBeUndefined();
        expect(theirs).toContain("boom");
        expect(ports.size).toBe(2);
    });

    it("names every module that fails to load and stops the worker", async () => {
        expect.assertions(4);

        writeFileSync(join(cwd, "lunora", "posts.ts"), "");
        respondWith({
            checked: 3,
            failures: [
                { functionPath: "posts:list", message: "boom at module scope" },
                { functionPath: "posts:add", message: "boom at module scope" },
            ],
        });

        const error = await run();

        expect(error).toContain("2 of 3 lazy function(s) fail to load:\n  lunora/posts.ts (list, add): boom at module scope\n");
        expect(error).toContain("--no-smoke-load");
        expect(stop).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(error);
    });

    it("hints at a circular import when a bundled module calls an import that is undefined", async () => {
        expect.assertions(2);

        mkdirSync(join(cwd, "lunora", "billing"), { recursive: true });
        writeFileSync(join(cwd, "lunora", "billing", "invoices.ts"), "");
        respondWith({ checked: 1, failures: [{ functionPath: "billing_invoices:ping", message: "(void 0) is not a function" }] });

        const error = await run();

        expect(error).toContain(
            "  lunora/billing/invoices.ts (ping): (void 0) is not a function\n      hint: if this module is part of a circular import, an import it reads is still undefined while it evaluates",
        );
        expect(error).not.toContain("boom");
    });

    // esbuild turns a circular `const` into `var`, so the real symptom is a plain `is not a function`, not `(void 0)`.
    it("keeps the circular-import hint for the plain TypeError a bundled circular import raises", async () => {
        expect.assertions(1);

        writeFileSync(join(cwd, "lunora", "posts.ts"), "");
        respondWith({ checked: 1, failures: [{ functionPath: "posts:list", message: "fromA is not a function" }] });

        await expect(run()).resolves.toContain("if this module is part of a circular import");
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("still lists the failing modules when a directory cannot be read", async () => {
        expect.assertions(3);

        const locked = join(cwd, "lunora", "locked");

        mkdirSync(locked, { recursive: true });
        chmodSync(locked, 0o000);

        try {
            respondWith({ checked: 1, failures: [{ functionPath: "posts:list", message: "boom" }] });

            const error = await run();

            expect(error).toContain("1 of 1 lazy function(s) fail to load:\n  posts (list): boom");
            expect(error).not.toContain("did not start");
            expect(logger.error).toHaveBeenCalledWith(error);
        } finally {
            chmodSync(locked, 0o755);
        }
    });

    it("reports how many functions it covered when nothing fails", async () => {
        expect.assertions(2);

        respondWith({ checked: 12, failures: [] });

        await expect(run()).resolves.toBeUndefined();
        expect(logger.success).toHaveBeenCalledWith("12 lazy function(s) evaluate cleanly");
    });

    it("blocks when the Worker does not start, so a broken entry cannot ship", async () => {
        expect.assertions(2);

        startDevProcess.mockRejectedValue(new Error("wrangler dev exited with code 1 before it was ready"));

        await expect(run()).resolves.toContain("the smoke Worker did not start (wrangler dev exited with code 1 before it was ready)");
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("did not start"));
    });

    it("warns instead of passing silently when the entry is not a file", async () => {
        expect.assertions(3);

        await expect(run({ composedEntry: "virtual:lunora/worker" })).resolves.toBeUndefined();
        expect(startDevProcess).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("smoke-load skipped"));
    });

    it("stays quiet for an eager registry, which has no lazy modules", async () => {
        expect.assertions(3);

        writeFileSync(join(cwd, "lunora", "_generated", "functions.ts"), "export const LUNORA_FUNCTIONS = {};\n");

        await expect(run()).resolves.toBeUndefined();
        expect(startDevProcess).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
    });

    describe("integration modules loaded with import()", () => {
        /** An eager project whose entry hands `stripe` to an integration through a loader, with `stripe` installed. */
        const eagerWithLoader = (): void => {
            writeFileSync(join(cwd, "lunora", "_generated", "functions.ts"), "export const LUNORA_FUNCTIONS = {};\n");
            writeFileSync(join(cwd, "src", "index.ts"), 'import { payments } from "./payments.js";\n\nexport default { payments };\n');
            writeFileSync(join(cwd, "src", "payments.ts"), 'export const payments = { client: async () => (await import("stripe")).default };\n');
            mkdirSync(join(cwd, "node_modules", "stripe"), { recursive: true });
            writeFileSync(join(cwd, "node_modules", "stripe", "package.json"), '{ "name": "stripe" }');
        };

        it("checks an eager build that loads an integration SDK with import(), without the lazy registry", async () => {
            expect.assertions(3);

            eagerWithLoader();

            let entry = "";

            startDevProcess.mockImplementation(async (options) => {
                entry = readFileSync(resolve(options.cwd, options.args.find((argument) => argument.endsWith("entry.ts")) ?? ""), "utf8");

                return { crashed: new Promise(() => {}), stop };
            });
            respondWith({ checked: 0, failures: [], integrations: { checked: 1, failures: [] } });

            await expect(run()).resolves.toBeUndefined();
            expect(entry).toContain('["stripe", () => import("stripe")]');
            expect(entry).not.toContain("loadAllFunctions");
        });

        it("blocks naming the module when an integration SDK fails to evaluate", async () => {
            expect.assertions(2);

            eagerWithLoader();
            respondWith({ checked: 0, failures: [], integrations: { checked: 1, failures: [{ message: "process is not defined", specifier: "stripe" }] } });

            const error = await run();

            expect(error).toContain('import("stripe"): process is not defined');
            expect(stop).toHaveBeenCalledWith();
        });

        it("stays quiet when the import()ed package is not installed where the smoke entry would resolve it", async () => {
            expect.assertions(2);

            eagerWithLoader();
            rmSync(join(cwd, "node_modules"), { force: true, recursive: true });

            await expect(run()).resolves.toBeUndefined();
            expect(startDevProcess).not.toHaveBeenCalled();
        });
    });

    describe("what the smoke Worker runs", () => {
        /** The entry file as it was when wrangler was started — it is removed again once the run ends. */
        const captureEntry = (): { read: () => { content: string; path: string } } => {
            const captured = { content: "", path: "" };

            startDevProcess.mockImplementation(async () => {
                captured.path = resolve(cwd, dev.mock.lastCall?.[0].extraArgs?.[0] ?? "");
                captured.content = readFileSync(captured.path, "utf8");

                return { crashed: new Promise(() => {}), stop };
            });

            return { read: () => captured };
        };

        it("re-exports the entry of the selected environment, not the top-level one", async () => {
            expect.assertions(2);

            writeFileSync(join(cwd, "src", "prod.ts"), "export default {};\n");
            writeFileSync(join(cwd, "wrangler.jsonc"), JSON.stringify({ env: { production: { main: "src/prod.ts" } }, main: "src/index.ts", name: "app" }));
            respondWith({ checked: 1, failures: [] });

            const entry = captureEntry();

            await run({ environment: "production" });

            expect(entry.read().content).toContain(join(cwd, "src", "prod.ts"));
            expect(entry.read().content).not.toContain(join(cwd, "src", "index.ts"));
        });

        it("stubs the bound classes against the source config, instead of the entry, once a Vite build has redirected wrangler", async () => {
            expect.assertions(5);

            writeFileSync(
                join(cwd, "wrangler.jsonc"),
                JSON.stringify({
                    durable_objects: {
                        bindings: [
                            { class_name: "ShardDO", name: "SHARD" },
                            { class_name: "Remote", name: "R", script_name: "other" },
                        ],
                    },
                    main: "src/index.ts",
                    name: "app",
                    workflows: [{ binding: "FLOW", class_name: "Flow", name: "flow" }],
                }),
            );
            // What `@cloudflare/vite-plugin` leaves: wrangler then runs the built, `no_bundle` copy, where a TypeScript entry cannot parse.
            mkdirSync(join(cwd, ".wrangler", "deploy"), { recursive: true });
            writeFileSync(join(cwd, ".wrangler", "deploy", "config.json"), JSON.stringify({ configPath: "../../dist/server/wrangler.json" }));
            respondWith({ checked: 1, failures: [] });

            const entry = captureEntry();

            await run();

            expect(entry.read().content).not.toContain("export * from");
            expect(entry.read().content).toContain("export class ShardDO extends DurableObject {}");
            expect(entry.read().content).toContain("export class Flow extends WorkflowEntrypoint");
            expect(entry.read().content).not.toContain("Remote");
            expect(dev.mock.calls[0]?.[0]).toStrictEqual(expect.objectContaining({ configPath: "wrangler.jsonc" }));
        });

        it("forces plain http and uses a directory of its own that is gone afterwards", async () => {
            expect.assertions(4);

            respondWith({ checked: 1, failures: [] });

            const entry = captureEntry();

            await run();
            const first = entry.read().path;

            await run();

            expect(dev.mock.calls[0]?.[0].extraArgs).toStrictEqual(expect.arrayContaining(["--local-protocol", "http"]));
            expect(entry.read().path).not.toBe(first);
            expect(existsSync(first)).toBe(false);
            expect(readdirSync(join(cwd, ".lunora"))).toStrictEqual([]);
        });

        it("skips a project that declares containers instead of building them locally", async () => {
            expect.assertions(2);

            writeFileSync(
                join(cwd, "wrangler.jsonc"),
                JSON.stringify({ containers: [{ class_name: "Box", image: "./Dockerfile" }], main: "src/index.ts", name: "app" }),
            );

            await expect(run()).resolves.toBeUndefined();
            expect(startDevProcess).not.toHaveBeenCalled();
        });

        it("skips a project whose Hyperdrive binding has no local database, which wrangler dev refuses to start without", async () => {
            expect.assertions(2);

            writeFileSync(join(cwd, "wrangler.jsonc"), JSON.stringify({ hyperdrive: [{ binding: "DB", id: "abc" }], main: "src/index.ts", name: "app" }));

            await expect(run()).resolves.toBeUndefined();
            expect(startDevProcess).not.toHaveBeenCalled();
        });
    });

    describe("a Worker that boots but does not answer", () => {
        const timeout = (): Error => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

        /** Answers the first request (which evaluates nothing) as this run's Worker, and every later one with `later`. */
        const answerPingThen = (later: (url: string) => Promise<Response>): void => {
            vi.stubGlobal(
                "fetch",
                vi.fn<(url: string) => Promise<Response>>(async (url) =>
                    new URL(url).searchParams.get("step") === "ping"
                        ? Response.json({ run: runIdOf(resolve(cwd, dev.mock.lastCall?.[0].extraArgs?.[0] ?? "")) })
                        : later(url),
                ),
            );
        };

        it("blocks on a 5xx that carries no result", async () => {
            expect.assertions(2);

            answerPingThen(async () => new Response("The script will never generate a response.", { status: 500 }));

            const error = await run();

            expect(error).toContain("failed while evaluating the lazy function modules (HTTP 500)");
            expect(stop).toHaveBeenCalledTimes(1);
        });

        it("names the step that never settles within the deadline", async () => {
            expect.assertions(1);

            answerPingThen(async () => {
                throw timeout();
            });

            await expect(run()).resolves.toContain("did not finish evaluating the lazy function modules within 120s");
        });

        it("names the integration module whose evaluation never settles", async () => {
            expect.assertions(2);

            writeFileSync(join(cwd, "lunora", "_generated", "functions.ts"), "export const LUNORA_FUNCTIONS = {};\n");
            writeFileSync(join(cwd, "src", "index.ts"), 'export default { a: () => import("fine"), b: () => import("stuck") };\n');

            for (const name of ["fine", "stuck"]) {
                mkdirSync(join(cwd, "node_modules", name), { recursive: true });
                writeFileSync(join(cwd, "node_modules", name, "package.json"), JSON.stringify({ name }));
            }

            answerPingThen(async (url) => {
                if (new URL(url).searchParams.get("specifier") === "stuck") {
                    throw timeout();
                }

                return answerStep(url, {}, runIdOf(resolve(cwd, dev.mock.lastCall?.[0].extraArgs?.[0] ?? "")));
            });

            const error = await run();

            expect(error).toContain('did not finish evaluating import("stuck") within 120s');
            expect(error).not.toContain('import("fine")');
        });

        it("says the runtime did not start, with wrangler's output, when not even a request that evaluates nothing is answered", async () => {
            expect.assertions(2);

            startDevProcess.mockImplementation(async (options) => {
                options.onLine("service core:user:app: Uncaught SyntaxError: Unexpected token ':'", "stderr");

                return { crashed: new Promise(() => {}), stop };
            });
            vi.stubGlobal(
                "fetch",
                vi.fn<() => Promise<Response>>(async () => {
                    throw timeout();
                }),
            );

            const error = await run();

            expect(error).toContain("answered no request within 120s, so its runtime did not start");
            expect(error).toContain("Uncaught SyntaxError: Unexpected token ':'");
        });

        it("stops waiting as soon as wrangler reports that the runtime failed to start", async () => {
            expect.assertions(2);

            startDevProcess.mockImplementation(async (options) => {
                options.onLine("service core:user:app: Uncaught SyntaxError: Unexpected token ':'", "stderr");
                options.onLine("✘ [ERROR] The Workers runtime failed to start.", "stderr");

                return { crashed: new Promise(() => {}), stop };
            });
            // Hangs until the request is aborted, the way wrangler's proxy holds a request for a runtime that never came up.
            vi.stubGlobal(
                "fetch",
                vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
                    async (_url, init) =>
                        new Promise((_resolve, reject) => {
                            const abort = (): void => {
                                reject(new Error("aborted"));
                            };

                            if (init.signal?.aborted) {
                                abort();
                            }

                            init.signal?.addEventListener("abort", abort);
                        }),
                ),
            );

            const error = await run();

            expect(error).toContain("the smoke Worker's runtime did not start, so nothing was evaluated");
            expect(error).toContain("Unexpected token ':'");
        });

        it("blocks when something other than the smoke Worker answers, and names the route to check", async () => {
            expect.assertions(2);

            vi.stubGlobal(
                "fetch",
                vi.fn<() => Promise<Response>>(async () => new Response("<html>app shell</html>", { status: 200, headers: { "content-type": "text/html" } })),
            );

            const error = await run();

            expect(error).toContain("something other than the probe's result (HTTP 200, text/html: <html>app shell</html>)");
            expect(error).toContain("run_worker_first");
        });
    });

    it("names an index module by its directory's namespace", async () => {
        expect.assertions(1);

        mkdirSync(join(cwd, "lunora", "ratelimit"), { recursive: true });
        writeFileSync(join(cwd, "lunora", "ratelimit", "index.ts"), "");
        respondWith({ checked: 1, failures: [{ functionPath: "ratelimit:consume", message: "boom" }] });

        await expect(run()).resolves.toContain("  lunora/ratelimit/index.ts (consume): boom");
    });

    it("passes the entry and the config as project-relative paths", async () => {
        expect.assertions(2);

        respondWith({ checked: 1, failures: [] });

        await run({ configPath: join(cwd, "wrangler.jsonc") });

        const request = dev.mock.calls[0]?.[0] as { configPath?: string; extraArgs: string[] };

        expect(isAbsolute(request.extraArgs[0] ?? "")).toBe(false);
        expect(request.configPath).toBe("wrangler.jsonc");
    });

    it("blocks a 5xx even when its body has the result shape", async () => {
        expect.assertions(1);

        vi.stubGlobal(
            "fetch",
            vi.fn<() => Promise<Response>>(async () => Response.json({ checked: 3, failures: [] }, { status: 500 })),
        );

        await expect(run()).resolves.toContain("(HTTP 500)");
    });

    it("keeps the check's storage in its own run directory, not the project's .wrangler/state", async () => {
        expect.assertions(3);

        respondWith({ checked: 1, failures: [] });

        await run();

        const extraArgs = dev.mock.calls[0]?.[0].extraArgs ?? [];
        const flag = extraArgs.indexOf("--persist-to");

        expect(flag).toBeGreaterThanOrEqual(0);
        expect(extraArgs[flag + 1]).toMatch(/^\.lunora\/smoke-/u);
        expect(extraArgs[flag + 1]).not.toContain(".wrangler");
    });

    it("warns, not blocks, when the run directory cannot be created", async () => {
        expect.assertions(2);

        writeFileSync(join(cwd, ".lunora"), "a file, not a directory");

        await expect(run()).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("could not create a directory for the check"));
    });

    it("starts the smoke server through the injected launcher", async () => {
        expect.assertions(1);

        respondWith({ checked: 1, failures: [] });
        const launcher = vi.fn<DevProcessSpawner>();

        await run({ launcher });

        expect(startDevProcess).toHaveBeenCalledWith(expect.objectContaining({ spawn: launcher }));
    });

    describe("deferred workflow, agent and queue modules", () => {
        const deferredTargets = {
            agent: { generated: "agents.ts", marker: 'import("../agents.js")', source: "agents.ts" },
            queue: { generated: "app.ts", marker: 'import("./queues.js")', source: join("_generated", "queues.ts") },
            workflow: { generated: "workflows.ts", marker: 'import("../workflows.js")', source: "workflows.ts" },
        } as const;

        /** A project that defers `kind` and has no lazy function manifest, whose deferred module is `source`. */
        const scaffoldDeferred = (kind: keyof typeof deferredTargets, source: string): void => {
            const target = deferredTargets[kind];

            rmSync(join(cwd, "lunora", "_generated", "functions.ts"));
            writeFileSync(join(cwd, "lunora", "_generated", target.generated), `const load = () => ${target.marker};\n`);
            writeFileSync(join(cwd, "lunora", target.source), source);
        };

        /** Runs the entry the check wrote, as the smoke Worker would, and answers the probe with what it returned. */
        const answerFromEntry = (): void => {
            startDevProcess.mockImplementation(async () => {
                const entry = resolve(cwd, dev.mock.lastCall?.[0].extraArgs?.[0] ?? "");
                const { default: worker } = (await import(entry)) as { default: { fetch: () => Promise<Response> } };
                const response = await worker.fetch();
                const body = (await response.json()) as object;

                vi.stubGlobal(
                    "fetch",
                    vi.fn<() => Promise<Response>>(async () => Response.json(body)),
                );

                return { crashed: new Promise(() => {}), stop };
            });
        };

        it.each(["agent", "workflow"] as const)("blocks a deferred %s module that throws on import, with no lazy function manifest", async (kind) => {
            expect.assertions(3);

            scaffoldDeferred(kind, 'throw new Error("boom at module scope");\n');
            answerFromEntry();

            const error = await run();

            expect(error).toContain(`1 of 1 lazy module(s) fail to load:\n  lunora/${deferredTargets[kind].source} (${kind}): boom at module scope`);
            expect(error).toContain("--no-smoke-load");
            expect(logger.error).toHaveBeenCalledWith(error);
        });

        it("blocks a deferred queue registry that throws on import", async () => {
            expect.assertions(1);

            scaffoldDeferred("queue", 'throw new Error("boom at module scope");\n');
            answerFromEntry();

            await expect(run()).resolves.toContain("lunora/_generated/queues.ts (queue): boom at module scope");
        });

        it.each(["agent", "queue", "workflow"] as const)("passes a healthy project that defers %s modules", async (kind) => {
            expect.assertions(2);

            scaffoldDeferred(kind, "export const ok = true;\n");
            answerFromEntry();

            await expect(run()).resolves.toBeUndefined();
            expect(logger.success).toHaveBeenCalledWith("0 lazy function(s) and 1 deferred module(s) evaluate cleanly");
        });

        /** A lazy `onEmail` handler as codegen emits it: it loads the inbound runtime and the agent definitions on the first message. */
        const scaffoldLazyEmail = (inbound: string): void => {
            scaffoldDeferred("agent", "export const ok = true;\n");
            writeFileSync(
                join(cwd, "lunora", "_generated", "app.ts"),
                'type Doc = import("./dataModel.js").Doc;\nconst load = () => Promise.all([import("@lunora/agent/inbound"), import("../agents.js")]);\n',
            );
            mkdirSync(join(cwd, "node_modules", "@lunora", "agent"), { recursive: true });
            writeFileSync(
                join(cwd, "node_modules", "@lunora", "agent", "package.json"),
                JSON.stringify({ exports: { "./inbound": "./inbound.mjs" }, name: "@lunora/agent", type: "module" }),
            );
            writeFileSync(join(cwd, "node_modules", "@lunora", "agent", "inbound.mjs"), inbound);
        };

        it("blocks a lazy email handler whose inbound module throws while it is evaluated", async () => {
            expect.assertions(2);

            scaffoldLazyEmail('throw new Error("inbound broke");\n');
            answerFromEntry();

            const error = await run();

            expect(error).toContain("@lunora/agent/inbound (module): inbound broke");
            expect(error).not.toContain("dataModel");
        });

        it("passes a lazy email handler whose inbound module evaluates, counting only the value imports", async () => {
            expect.assertions(2);

            scaffoldLazyEmail("export const dispatchAgentEmail = () => {};\n");
            answerFromEntry();

            await expect(run()).resolves.toBeUndefined();
            expect(logger.success).toHaveBeenCalledWith("0 lazy function(s) and 2 deferred module(s) evaluate cleanly");
        });

        it("blocks a live-stream module that a lazy build loads through import().then()", async () => {
            expect.assertions(1);

            writeFileSync(
                join(cwd, "lunora", "_generated", "app.ts"),
                'type Doc = import("./dataModel.js").Doc;\nconst live = () => import("../live.js").then((module) => module.default);\n',
            );
            writeFileSync(join(cwd, "lunora", "live.ts"), 'throw new Error("live broke");\n');
            answerFromEntry();

            await expect(run()).resolves.toContain("lunora/live.ts (module): live broke");
        });

        it("stays quiet for an eager build whose generated output still loads auth behind import()", async () => {
            expect.assertions(2);

            rmSync(join(cwd, "lunora", "_generated", "functions.ts"));
            writeFileSync(join(cwd, "lunora", "_generated", "app.ts"), 'const load = async () => ({ auth: await import("./authModule.js") });\n');
            writeFileSync(join(cwd, "lunora", "_generated", "authModule.ts"), 'throw new Error("auth broke");\n');

            await expect(run()).resolves.toBeUndefined();
            expect(startDevProcess).not.toHaveBeenCalled();
        });

        it("reports function failures and deferred failures together", async () => {
            expect.assertions(1);

            respondWith({
                checked: 2,
                deferredChecked: 1,
                failures: [
                    { functionPath: "posts:list", message: "boom" },
                    { deferred: "workflow", functionPath: "workflow:lunora/workflows.ts", message: "late" },
                ],
            });

            await expect(run()).resolves.toContain("2 of 3 lazy module(s) fail to load:\n  posts (list): boom\n  lunora/workflows.ts (workflow): late");
        });

        it("stays quiet when the generated output defers nothing and has no manifest", async () => {
            expect.assertions(2);

            rmSync(join(cwd, "lunora", "_generated", "functions.ts"));

            await expect(run()).resolves.toBeUndefined();
            expect(startDevProcess).not.toHaveBeenCalled();
        });
    });
});
