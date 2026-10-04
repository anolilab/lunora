import { existsSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Compiler, Stats } from "@rspack/core";
import { rspack } from "@rspack/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lunoraRspack } from "../src/index";
import { createFixture, SCHEMA, SCHEMA_WITH_ERROR_ADVISORY, SCHEMA_WITH_GLOBAL, WRANGLER } from "./fixture";

/**
 * End-to-end coverage against a REAL `@rspack/core` compiler.
 *
 * This suite exists because a hand-rolled compiler double cannot be trusted to
 * reproduce the compiler's own lifecycle. The first version of this package set
 * `watchMode` on a fake compiler *before* calling `apply()` and every unit test
 * passed — while the real compiler, which assigns `watchMode` in `watch()` long
 * after `apply()` runs inside `createCompiler()`, took the opposite branch every
 * time. Two shipped behaviours (dev-var scaffolding, watch-mode escalation) were
 * dead or inverted underneath a green suite.
 *
 * So: real compiler, real filesystem, real hook ordering. Nothing here is a
 * double.
 */

/** The advisory a deliberately-broken schema raises; matched in two places. */
const ERROR_ADVISORY_RE = /ERROR-level.*index_references_unknown_field/u;

/** Roots created by a test, removed afterwards. */
const roots: string[] = [];

/** Every path under `root`, the root itself included. */
const walk = (root: string): string[] => [root, ...readdirSync(root, { recursive: true, encoding: "utf8" }).map((entry) => join(root, entry))];

/**
 * Backdate everything a fixture wrote, well past the watcher's initial-scan window.
 *
 * Watchpack's first scan treats any file whose mtime lies within its filesystem
 * accuracy (up to 2s, refined to ~10ms once it has seen an mtime) of the
 * watcher's start as possibly changed, and fires a rebuild for it. A fixture
 * written moments before `compiler.watch()` therefore produced a free second
 * build — or not, depending on how long the runner took to construct the
 * compiler. A test whose own edit was never watched still passed on the free
 * build, and hung forever on a runner slow enough to miss it: that is how
 * "clears a wrangler failure" timed out on CI while the plugin did not watch an
 * absent `wrangler.jsonc` at all. With the fixture aged, the ONLY thing that can
 * start the next build is the edit a test makes.
 */
const ageFixture = (root: string): void => {
    const past = new Date(Date.now() - 60_000);

    for (const path of walk(root)) {
        utimesSync(path, past, past);
    }
};

const fixture = (...args: Parameters<typeof createFixture>): string => {
    const root = createFixture(...args);

    roots.push(root);

    return root;
};

/** A production (one-shot) compiler over `root`, with the plugin applied. */
const productionCompiler = (root: string): Compiler =>
    rspack({
        context: root,
        entry: "./index.js",
        mode: "production",
        output: { path: join(root, "dist") },
        plugins: [lunoraRspack({ projectRoot: root })],
    });

/** Run a compiler once and resolve its stats. */
const runOnce = async (compiler: Compiler): Promise<Stats> =>
    new Promise<Stats>((resolve, reject) => {
        compiler.run((error, stats) => {
            compiler.close(() => {
                if (error) {
                    reject(error);

                    return;
                }

                resolve(stats as Stats);
            });
        });
    });

/** The compilation's error messages, as plain strings. */
const errorsOf = (stats: Stats): string[] => stats.toJson({ all: false, errors: true }).errors?.map((entry) => entry.message ?? "") ?? [];

/** Promisified `Watching#close` — module scope so the teardown chain stays flat. */
const closeWatching = async (watching: { close: (callback: () => void) => void }): Promise<void> =>
    new Promise((resolve) => {
        watching.close(() => {
            resolve();
        });
    });

/** Promisified `Compiler#close`. Leaving either open keeps the vitest worker alive. */
const closeCompiler = async (compiler: Compiler): Promise<void> =>
    new Promise((resolve) => {
        compiler.close(() => {
            resolve();
        });
    });

/**
 * How long a watch session may take to reach the build count a test expects.
 * Below the 60s test timeout on purpose: a session that stalls fails with the
 * builds it DID see, and is torn down, instead of surfacing as a bare timeout
 * that leaves its watcher running into the next test.
 */
const WATCH_DEADLINE_MS = 40_000;

/**
 * Teardowns of the watch sessions still open. A session that never settles must
 * not outlive its test: a leaked watcher kept rebuilding against a deleted
 * fixture and, when its promise finally resolved, ran the dead test's
 * assertions inside the NEXT test ("expected number of assertions to be 2, but
 * got 4").
 */
const openSessions = new Set<() => Promise<void>>();

/**
 * Watch `root`, run `act(n)` after build `n`, and resolve with every build's
 * error list plus the total build count.
 *
 * `settleMs` is spent idle AFTER the last build the test expects, which is how
 * a regeneration cascade is detected: an unterminated one keeps producing
 * builds through that window.
 */
const watchRun = async (
    root: string,
    act: (buildNumber: number) => void,
    options: { expectedBuilds: number; settleMs: number },
): Promise<{ builds: string[][]; devVarsExists: boolean }> =>
    new Promise((resolve, reject) => {
        ageFixture(root);

        const compiler = rspack({
            context: root,
            entry: "./index.js",
            mode: "development",
            output: { path: join(root, "dist") },
            plugins: [lunoraRspack({ projectRoot: root })],
        });

        const builds: string[][] = [];
        let settleTimer: NodeJS.Timeout | undefined;
        let watching: ReturnType<typeof compiler.watch> | undefined;
        let closing: Promise<void> | undefined;

        const teardown = async (): Promise<void> => {
            closing ??= (async () => {
                clearTimeout(settleTimer);
                // eslint-disable-next-line @typescript-eslint/no-use-before-define -- the deadline is armed after the session it tears down
                clearTimeout(deadline);
                openSessions.delete(teardown);

                if (watching !== undefined) {
                    await closeWatching(watching);
                }

                await closeCompiler(compiler);
            })();

            await closing;
        };

        const fail = (reason: Error): void => {
            const rejectAfterTeardown = async (): Promise<void> => {
                try {
                    await teardown();
                } finally {
                    reject(reason);
                }
            };

            rejectAfterTeardown().catch(reject);
        };

        const deadline = setTimeout(() => {
            fail(
                new Error(
                    `watch session reached ${String(builds.length)} of ${String(options.expectedBuilds)} expected builds in ${String(WATCH_DEADLINE_MS)}ms — ` +
                        `the edit after build ${String(builds.length)} started no rebuild. Errors per build so far: ${JSON.stringify(builds)}`,
                ),
            );
        }, WATCH_DEADLINE_MS);

        openSessions.add(teardown);

        // Read `.dev.vars` before tearing down: the teardown removes nothing, but
        // reading first keeps the assertion independent of close ordering.
        const finish = (): void => {
            const devVarsExists = existsSync(join(root, ".dev.vars"));

            const resolveAfterTeardown = async (): Promise<void> => {
                await teardown();

                resolve({ builds, devVarsExists });
            };

            resolveAfterTeardown().catch(reject);
        };

        watching = compiler.watch({ aggregateTimeout: 50, poll: false }, (error, stats) => {
            if (closing !== undefined) {
                return;
            }

            if (error) {
                fail(error);

                return;
            }

            builds.push(errorsOf(stats as Stats));

            if (builds.length < options.expectedBuilds) {
                act(builds.length);

                return;
            }

            clearTimeout(deadline);
            clearTimeout(settleTimer);
            settleTimer = setTimeout(finish, options.settleMs);
        });
    });

describe("rspack build (real compiler)", () => {
    afterEach(() => {
        for (const root of roots.splice(0)) {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("generates the API surface and emits the bundle", async () => {
        expect.assertions(3);

        const root = fixture();
        const stats = await runOnce(productionCompiler(root));

        expect(errorsOf(stats)).toStrictEqual([]);
        expect(readFileSync(join(root, "lunora", "_generated", "api.ts"), "utf8")).toContain("list: FunctionReference");
        expect(existsSync(join(root, "dist", "main.js"))).toBe(true);
    }, 60_000);

    it("writes the D1 binding a .global() table implies into wrangler.jsonc", async () => {
        expect.assertions(2);

        const root = fixture({ dependencies: { "@lunora/d1": "*" }, schema: SCHEMA_WITH_GLOBAL });
        const stats = await runOnce(productionCompiler(root));

        expect(errorsOf(stats)).toStrictEqual([]);

        // Read the config back rather than merely asserting the build succeeded:
        // provisioning could no-op and validation could stop requiring `DB`, and a
        // pass/fail assertion alone would not notice either.
        expect(readFileSync(join(root, "wrangler.jsonc"), "utf8")).toContain("d1_databases");
    }, 60_000);

    it("fails the build on an ERROR-level advisory, and emits no bundle", async () => {
        expect.assertions(2);

        const root = fixture({ schema: SCHEMA_WITH_ERROR_ADVISORY });
        const stats = await runOnce(productionCompiler(root));

        expect(errorsOf(stats).join("\n")).toMatch(ERROR_ADVISORY_RE);

        // A reported error is only a real gate if it also stops the output: an
        // advisory says a call throws at runtime, so shipping the bundle anyway
        // would make the gate cosmetic.
        expect(existsSync(join(root, "dist", "main.js"))).toBe(false);
    }, 60_000);

    it("keeps generating under LUNORA_CODEGEN=0, so the production gate still fires", async () => {
        expect.assertions(2);

        const root = fixture({ schema: SCHEMA_WITH_ERROR_ADVISORY });

        // `LUNORA_CODEGEN` is a dev switch. If a one-shot build honoured it, an app
        // could ship against a surface its target cannot serve — green the whole
        // way — because someone exported a variable in a shell profile.
        vi.stubEnv("LUNORA_CODEGEN", "0");

        try {
            const stats = await runOnce(productionCompiler(root));

            expect(errorsOf(stats).join("\n")).toMatch(ERROR_ADVISORY_RE);
            expect(existsSync(join(root, "lunora", "_generated"))).toBe(true);
        } finally {
            vi.unstubAllEnvs();
        }
    }, 60_000);

    it("reports a wrangler config that cannot satisfy the schema without crashing the compiler", async () => {
        expect.assertions(1);

        const root = fixture({ wrangler: false });
        const stats = await runOnce(productionCompiler(root));

        expect(errorsOf(stats).join("\n")).toContain("wrangler.jsonc not found");
    }, 60_000);

    it("reports a codegen crash as a build error rather than rejecting the hook", async () => {
        expect.assertions(1);

        const root = fixture();

        writeFileSync(join(root, "lunora", "schema.ts"), "export const schema = notDefineSchema(;\n", "utf8");

        // A rejected `beforeCompile` takes a watch session down with it. Even in a
        // one-shot build the failure has to arrive as a compilation error, because
        // that is the single path both modes share.
        const stats = await runOnce(productionCompiler(root));

        expect(errorsOf(stats)).not.toStrictEqual([]);
    }, 60_000);
});

describe("rspack watch (real compiler)", () => {
    afterEach(async () => {
        // Close any session a failed or timed-out test left watching BEFORE its
        // fixture is deleted out from under it.
        await Promise.all([...openSessions].map(async (teardown) => teardown()));

        for (const root of roots.splice(0)) {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("rebuilds on a newly added function file and settles, with no regeneration cascade", async () => {
        expect.assertions(3);

        const root = fixture();

        const { builds } = await watchRun(
            root,
            () => {
                writeFileSync(
                    join(root, "lunora", "ping.ts"),
                    'import { query } from "./_generated/server";\n\nexport const ping = query({ args: {}, handler: async () => "pong" });\n',
                    "utf8",
                );
            },
            { expectedBuilds: 2, settleMs: 2500 },
        );

        // Discovered without being imported from anywhere — the reason the whole
        // schema directory is watched rather than a file list.
        expect(readFileSync(join(root, "lunora", "_generated", "api.ts"), "utf8")).toContain("ping");
        expect(builds.flat()).toStrictEqual([]);

        // Codegen's own writes land inside the watched directory, and the first
        // pass reconciles an inferred binding into the watched `wrangler.jsonc`.
        // Three builds is the ceiling: the initial one, the new file, and that
        // one-time reconcile write. Settling at all inside the window is the
        // assertion — an ungated cascade keeps building through it.
        expect(builds.length).toBeLessThanOrEqual(3);
    }, 60_000);

    it("does not let a postcodegen hook that rewrites generated output loop forever", async () => {
        expect.assertions(1);

        const root = fixture({
            scripts: { postcodegen: String.raw`node -e "require('fs').appendFileSync('lunora/_generated/api.ts', '// formatted\n')"` },
        });

        const { builds } = await watchRun(
            root,
            () => {
                writeFileSync(join(root, "lunora", "schema.ts"), `${SCHEMA}\n// touched\n`, "utf8");
            },
            { expectedBuilds: 2, settleMs: 4000 },
        );

        // The documented guarantee: "a postcodegen that writes under lunora/ will
        // not retrigger the dev watchers". Before the source-fingerprint gate this
        // measured 73 builds in 25 seconds, each spawning a subprocess.
        expect(builds.length).toBeLessThanOrEqual(3);
    }, 60_000);

    it("scaffolds .dev.vars, which only runs when watchMode is actually true", async () => {
        expect.assertions(3);

        const root = fixture();

        writeFileSync(join(root, ".dev.vars"), "EXISTING=1\n", "utf8");

        const { builds, devVarsExists } = await watchRun(
            root,
            () => {
                writeFileSync(join(root, "lunora", "schema.ts"), `${SCHEMA}\n// touched\n`, "utf8");
            },
            { expectedBuilds: 2, settleMs: 2000 },
        );

        expect(devVarsExists).toBe(true);

        // `WORKER_ENV` is the step a BYO-worker project needs and the Vite plugin
        // owns. Its presence proves `prepareDevSession` ran at all — it is
        // unreachable whenever `watchMode` is read before `watch()` assigns it.
        expect(readFileSync(join(root, ".dev.vars"), "utf8")).toContain("WORKER_ENV");
        expect(builds.flat()).toStrictEqual([]);
    }, 60_000);

    it("clears a wrangler failure once the config is fixed, without touching the schema", async () => {
        expect.assertions(2);

        const root = fixture({ wrangler: false });

        const { builds } = await watchRun(
            root,
            () => {
                // Only `wrangler.jsonc` changes — the schema is untouched. The pass
                // has to rerun anyway: its fingerprint covers the wrangler config,
                // and a failed pass does not record one, so the stale finding is
                // not replayed forever.
                writeFileSync(join(root, "wrangler.jsonc"), WRANGLER, "utf8");
            },
            { expectedBuilds: 2, settleMs: 2500 },
        );

        expect(builds[0]?.join("\n")).toContain("wrangler.jsonc not found");
        expect(builds.at(-1)).toStrictEqual([]);
    }, 60_000);

    it("stops re-running a pass that keeps failing on identical inputs", async () => {
        expect.assertions(2);

        // Every `postcodegen` run appends a line, so the file counts invocations.
        // It lives outside `lunora/` and is not the tsconfig or wrangler config, so
        // it never moves the fingerprint.
        const root = fixture({
            scripts: { postcodegen: `node -e "require('fs').appendFileSync('.hook-runs', 'x'); process.exit(1)"` },
        });

        await runOnce(productionCompiler(root));
        rmSync(join(root, ".hook-runs"), { force: true });

        const { builds } = await watchRun(
            root,
            (buildNumber) => {
                // Each touch is a rebuild on UNCHANGED codegen inputs — editing app
                // code while a hook is broken. A failed pass records no fingerprint
                // so it retries, and without a cap every such save re-runs codegen
                // and respawns the failing hook.
                writeFileSync(join(root, "index.js"), `console.log("app");\n// ${String(buildNumber)}\n`, "utf8");
            },
            { expectedBuilds: 5, settleMs: 2000 },
        );

        // Bounded by MAX_FAILED_RETRIES, not by the number of rebuilds.
        expect(readFileSync(join(root, ".hook-runs"), "utf8").length).toBeLessThanOrEqual(2);

        // Capping the re-runs must not silently drop the error.
        expect(builds.at(-1)?.join("\n")).toContain("postcodegen");
    }, 60_000);

    it("retries a failed pass whose fix changes nothing the fingerprint covers", async () => {
        expect.assertions(2);

        // The hook fails until a sentinel appears. The sentinel sits OUTSIDE
        // `lunora/` and is not the tsconfig or the wrangler config, so creating it
        // changes no fingerprinted input — the pass can only rerun because a failed
        // one records no fingerprint. Recording it up front pinned the failure: the
        // stale finding replayed on every later compilation with no way to clear it.
        const root = fixture({ scripts: { postcodegen: `node -e "process.exit(require('fs').existsSync('.hook-ok') ? 0 : 1)"` } });

        // Settle the project first. The very first pass on a fresh fixture
        // reconciles an inferred binding INTO the watched `wrangler.jsonc`, which
        // moves the fingerprint on its own and would let the pass rerun for the
        // wrong reason — masking exactly what this test is for.
        await runOnce(productionCompiler(root));

        const { builds } = await watchRun(
            root,
            () => {
                writeFileSync(join(root, ".hook-ok"), "", "utf8");
                // `index.js` is rspack's entry, watched by rspack and absent from the
                // fingerprint — it is what makes a rebuild happen at all here.
                writeFileSync(join(root, "index.js"), 'console.log("app");\n// touched\n', "utf8");
            },
            { expectedBuilds: 2, settleMs: 2500 },
        );

        expect(builds[0]).not.toStrictEqual([]);
        expect(builds.at(-1)).toStrictEqual([]);
    }, 60_000);

    it("logs an ERROR-level advisory without failing the rebuild", async () => {
        expect.assertions(1);

        const root = fixture();

        const { builds } = await watchRun(
            root,
            () => {
                writeFileSync(join(root, "lunora", "schema.ts"), SCHEMA_WITH_ERROR_ADVISORY, "utf8");
            },
            { expectedBuilds: 2, settleMs: 2000 },
        );

        // The opposite of the production case above: a half-typed schema must not
        // take the watcher down, which is what a thrown finding would do.
        expect(builds.flat()).toStrictEqual([]);
    }, 60_000);
});
