import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runVerifyCommand } from "../../src/commands/verify/handler";
import type { Logger } from "../../src/util/logger";
import { createRecordingSpawner } from "../../src/util/spawn";

/** Run async `body` while capturing everything written to `process.stdout`. */
const captureStdout = async (body: () => Promise<void>): Promise<string> => {
    let captured = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
        captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");

        return true;
    });

    try {
        await body();
    } finally {
        spy.mockRestore();
    }

    return captured;
};

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "..", "..", "codegen", "__tests__", "fixtures", "simple");

const VALID_WRANGLER = `{
    "name": "lunora-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "y" }]
}
`;

const TSCONFIG = `{ "compilerOptions": { "noEmit": true } }\n`;

interface Recorded {
    errors: string[];
    infos: string[];
    successes: string[];
    warnings: string[];
}

const recordingLogger = (): { logger: Logger; recorded: Recorded } => {
    const recorded: Recorded = { errors: [], infos: [], successes: [], warnings: [] };

    return {
        logger: {
            error: (message) => recorded.errors.push(message),
            info: (message) => recorded.infos.push(message),
            success: (message) => recorded.successes.push(message),
            warn: (message) => recorded.warnings.push(message),
        },
        recorded,
    };
};

let workdir: string;

describe("lunora verify", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-verify-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("lunora verify", () => {
        it("returns 0 and writes nothing when wrangler + codegen are both valid", async () => {
            expect.assertions(4);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
            const { logger, recorded } = recordingLogger();

            const result = await runVerifyCommand({ cwd: workdir, logger });

            expect(result.code).toBe(0);
            expect(result.errors).toEqual([]);
            expect(recorded.successes.join("\n")).toContain("valid");
            // Dry-run must not have created the _generated/ directory.
            expect(existsSync(join(workdir, "lunora", "_generated"))).toBe(false);
        });

        describe("eRROR-level codegen advisories", () => {
            /** An index over a column the table never declares — a canonical ERROR advisory. */
            const addBogusIndexToSchema = (): void => {
                const schemaPath = join(workdir, "lunora", "schema.ts");
                const schema = readFileSync(schemaPath, "utf8");
                const patched = schema.replace(
                    `.searchIndex("by_text", { field: "text", filterFields: ["channelId"] }),`,
                    `.searchIndex("by_text", { field: "text", filterFields: ["channelId"] })\n        .index("by_bogus", ["doesNotExist"]),`,
                );

                expect(patched).not.toBe(schema);

                writeFileSync(schemaPath, patched, "utf8");
            };

            it("blocks under --strict-advisories, so verify does not pass what prepare and deploy reject", async () => {
                expect.assertions(3);

                // `verify` already runs the OTHER two gates codegen produces (the
                // platform diagnostics and the schema drift gate) and nothing read
                // `codegen.advisories` — so the documented pre-deploy gate went green
                // on the exact projects `prepare`/`deploy` refuse. An ERROR advisory
                // means the call throws at runtime, which is what verify exists to
                // catch before a deploy does.
                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
                addBogusIndexToSchema();

                const { logger } = recordingLogger();
                const result = await runVerifyCommand({ cwd: workdir, logger, strictAdvisories: true, typecheck: false });

                expect(result.code).toBe(1);
                expect(result.errors.join("\n")).toContain("ERROR-level");
            });

            it("passes the same project under --no-strict-advisories, the opt-out it now accepts", async () => {
                expect.assertions(2);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
                addBogusIndexToSchema();

                const { logger } = recordingLogger();
                const result = await runVerifyCommand({ cwd: workdir, logger, strictAdvisories: false, typecheck: false });

                expect(result.code).toBe(0);
            });
        });

        it("fails on a platform diagnostic — the target it just resolved cannot serve the app", async () => {
            expect.assertions(3);

            // `verify` is the documented CI/pre-deploy gate, and it resolves and
            // validates the deploy target immediately before running codegen with
            // it. Dropping the one output that depends on that target let an app
            // whose nightly cron can never fire on this host verify clean.
            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
            writeFileSync(join(workdir, "lunora.json"), `{ "target": "node" }`, "utf8");
            writeFileSync(
                join(workdir, "lunora", "crons.ts"),
                `import { cronJobs } from "@lunora/server";\n\nconst crons = cronJobs();\n\ncrons.daily("nightly-billing-sweep", { hourUTC: 3, minuteUTC: 0 }, internal.messages.purge, {});\n\nexport default crons;\n`,
                "utf8",
            );
            const { logger, recorded } = recordingLogger();

            const result = await runVerifyCommand({ cwd: workdir, logger, typecheck: false });

            expect(result.code).toBe(1);
            expect(result.errors.some((error) => error.includes("cron"))).toBe(true);
            expect(recorded.errors.join("\n")).toContain("platform_unsupported_feature");
        });

        it("reports every platform diagnostic, not just the first", async () => {
            expect.assertions(3);

            // `--format json` consumers read `errors` — the documented CI gate.
            // Only the FIRST error-level diagnostic reached the result, so an app
            // with two unsupported features had one of them silently dropped from
            // the machine-readable output that gates the pipeline.
            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
            writeFileSync(join(workdir, "lunora.json"), `{ "target": "node" }`, "utf8");
            writeFileSync(
                join(workdir, "lunora", "crons.ts"),
                `import { cronJobs } from "@lunora/server";\n\nconst crons = cronJobs();\n\ncrons.daily("nightly-billing-sweep", { hourUTC: 3, minuteUTC: 0 }, internal.messages.purge, {});\n\nexport default crons;\n`,
                "utf8",
            );
            writeFileSync(
                join(workdir, "lunora", "summarize.ts"),
                `import { action } from "@lunora/server";\n\nexport const summarize = action({ args: {}, handler: async (ctx) => ctx.ai.run("@cf/meta/llama", { prompt: "hi" }) });\n`,
                "utf8",
            );
            const { logger } = recordingLogger();

            const result = await runVerifyCommand({ cwd: workdir, logger, typecheck: false });

            expect(result.code).toBe(1);
            expect(result.errors.some((error) => error.includes("cron"))).toBe(true);
            expect(result.errors.some((error) => error.toLowerCase().includes("ai"))).toBe(true);
        });

        it("returns 1 and surfaces wrangler errors", async () => {
            expect.assertions(3);

            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["web_socket_auto_reply_to_close"]
}`,
                "utf8",
            );
            const { logger, recorded } = recordingLogger();

            const result = await runVerifyCommand({ cwd: workdir, logger });

            expect(result.code).toBe(1);
            expect(result.errors.length).toBeGreaterThan(0);
            expect(recorded.errors.join("\n")).toContain("errors:");
        });

        it("returns 1 when codegen discovery fails (broken schema)", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
            writeFileSync(join(workdir, "lunora", "schema.ts"), "this is not valid typescript syntax {{{", "utf8");
            const { logger } = recordingLogger();

            const result = await runVerifyCommand({ cwd: workdir, logger });

            expect(result.code).toBe(1);
            expect(result.errors.some((error) => error.includes("codegen failed"))).toBe(true);
        });

        it("prints the matched Lunora fix under a recognized codegen error", async () => {
            expect.assertions(3);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
            // Valid TypeScript with no `defineSchema()` call → codegen throws the
            // recognized "defineSchema() not found" error, which carries a fix hint.
            writeFileSync(join(workdir, "lunora", "schema.ts"), "export const notASchema = 1;", "utf8");
            const { logger, recorded } = recordingLogger();

            const result = await runVerifyCommand({ cwd: workdir, logger });

            expect(result.code).toBe(1);
            expect(result.errors.some((error) => error.includes("codegen failed"))).toBe(true);
            // The fix hint (solution header) is rendered alongside the error bullet.
            expect(recorded.errors.join("\n")).toContain("No Lunora schema found");
        });

        it("returns 1 when wrangler.jsonc is missing", async () => {
            expect.assertions(3);

            const { logger } = recordingLogger();
            // No wrangler.jsonc written.
            const filesBefore = readdirSync(workdir);

            expect(filesBefore).not.toContain("wrangler.jsonc");

            const result = await runVerifyCommand({ cwd: workdir, logger });

            expect(result.code).toBe(1);
            expect(result.errors.join("\n")).toContain("wrangler.jsonc");
        });

        it("runs tsc --noEmit and passes when the type-check exits 0", async () => {
            expect.assertions(5);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
            writeFileSync(join(workdir, "tsconfig.json"), TSCONFIG, "utf8");
            const { logger, recorded } = recordingLogger();
            const { calls, spawner } = createRecordingSpawner(0);

            const result = await runVerifyCommand({ cwd: workdir, logger, spawner });

            expect(result.code).toBe(0);
            expect(result.errors).toEqual([]);
            expect(recorded.successes.join("\n")).toContain("valid");
            expect(calls).toHaveLength(1);
            expect(calls[0]?.descriptor).toMatchObject({
                args: ["exec", "tsc", "--noEmit", "-p", "tsconfig.json"],
                command: "pnpm",
                cwd: workdir,
            });
        });

        it("routes tsc through npx when the project declares npm", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
            writeFileSync(join(workdir, "tsconfig.json"), TSCONFIG, "utf8");
            // `detectPackageManager` reads the nearest package.json's `packageManager`.
            writeFileSync(join(workdir, "package.json"), `{ "packageManager": "npm@10.9.0" }\n`, "utf8");
            const { logger } = recordingLogger();
            const { calls, spawner } = createRecordingSpawner(0);

            await runVerifyCommand({ cwd: workdir, logger, spawner });

            expect(calls).toHaveLength(1);
            expect(calls[0]?.descriptor).toMatchObject({
                args: ["--", "tsc", "--noEmit", "-p", "tsconfig.json"],
                command: "npx",
                cwd: workdir,
            });
        });

        it("returns 1 with a type-error message when tsc exits non-zero", async () => {
            expect.assertions(3);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
            writeFileSync(join(workdir, "tsconfig.json"), TSCONFIG, "utf8");
            const { logger } = recordingLogger();
            const { calls, spawner } = createRecordingSpawner(2);

            const result = await runVerifyCommand({ cwd: workdir, logger, spawner });

            expect(result.code).toBe(1);
            expect(result.errors.some((error) => error.includes("type errors"))).toBe(true);
            expect(calls).toHaveLength(1);
        });

        it("skips the type-check with a warning when no tsconfig.json is present", async () => {
            expect.assertions(4);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
            const { logger, recorded } = recordingLogger();
            const { calls, spawner } = createRecordingSpawner(0);

            const result = await runVerifyCommand({ cwd: workdir, logger, spawner });

            expect(result.code).toBe(0);
            expect(calls).toHaveLength(0);
            expect(recorded.warnings.join("\n")).toContain("tsconfig.json");
            expect(recorded.warnings.join("\n")).toContain("skipping");
        });

        it("skips the type-check entirely when typecheck is false", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
            writeFileSync(join(workdir, "tsconfig.json"), TSCONFIG, "utf8");
            const { logger } = recordingLogger();
            const { calls, spawner } = createRecordingSpawner(2);

            const result = await runVerifyCommand({ cwd: workdir, logger, spawner, typecheck: false });

            expect(result.code).toBe(0);
            expect(calls).toHaveLength(0);
        });

        describe("--health-url probe", () => {
            it("is skipped by default (no healthUrl) so verify stays offline-safe", async () => {
                expect.assertions(3);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
                const { logger } = recordingLogger();
                const healthFetch = vi.fn<() => Promise<{ ok: boolean; status: number }>>(async () => {
                    return { ok: true, status: 200 };
                });

                const result = await runVerifyCommand({ cwd: workdir, healthFetch, logger, typecheck: false });

                expect(result.code).toBe(0);
                // No healthUrl → the probe never fires.
                expect(healthFetch).not.toHaveBeenCalled();
                expect(result.errors).toEqual([]);
            });

            it("passes when the deployment's /_lunora/health returns 200", async () => {
                expect.assertions(3);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
                const { logger, recorded } = recordingLogger();
                const healthFetch = vi.fn<() => Promise<{ ok: boolean; status: number }>>(async () => {
                    return { ok: true, status: 200 };
                });

                const result = await runVerifyCommand({
                    cwd: workdir,
                    healthFetch,
                    healthUrl: "https://my-app.workers.dev",
                    logger,
                    typecheck: false,
                });

                expect(result.code).toBe(0);
                expect(healthFetch).toHaveBeenCalledWith("https://my-app.workers.dev/_lunora/health");
                expect(recorded.successes.join("\n")).toContain("health probe ok");
            });

            it("fails red when the health endpoint returns 503", async () => {
                expect.assertions(3);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
                const { logger } = recordingLogger();
                const healthFetch = vi.fn<() => Promise<{ ok: boolean; status: number }>>(async () => {
                    return { ok: false, status: 503 };
                });

                const result = await runVerifyCommand({
                    cwd: workdir,
                    healthFetch,
                    healthUrl: "https://my-app.workers.dev/",
                    logger,
                    typecheck: false,
                });

                expect(result.code).toBe(1);
                expect(result.errors.some((error) => error.includes("health probe failed"))).toBe(true);
                // A trailing slash on the base URL doesn't double up in the probed URL.
                expect(healthFetch).toHaveBeenCalledWith("https://my-app.workers.dev/_lunora/health");
            });

            it("fails red when the probe can't reach the deployment", async () => {
                expect.assertions(2);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
                const { logger } = recordingLogger();
                const healthFetch = vi.fn<() => Promise<{ ok: boolean; status: number }>>(async () => {
                    throw new Error("ECONNREFUSED");
                });

                const result = await runVerifyCommand({
                    cwd: workdir,
                    healthFetch,
                    healthUrl: "https://my-app.workers.dev",
                    logger,
                    typecheck: false,
                });

                expect(result.code).toBe(1);
                expect(result.errors.some((error) => error.includes("could not reach"))).toBe(true);
            });
        });

        describe("--format json", () => {
            it("emits a single parseable JSON document with the structured result", async () => {
                expect.assertions(5);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
                const { logger } = recordingLogger();

                const stdout = await captureStdout(async () => {
                    await runVerifyCommand({ cwd: workdir, format: "json", logger, typecheck: false });
                });

                const parsed = JSON.parse(stdout) as { code: number; errors: unknown[]; warnings: unknown[]; wranglerPath: unknown };

                expect(parsed.code).toBe(0);
                expect(Array.isArray(parsed.errors)).toBe(true);
                expect(Array.isArray(parsed.warnings)).toBe(true);
                expect(parsed).toHaveProperty("wranglerPath");
                expect(parsed.errors).toEqual([]);
            });

            it("serializes errors into the JSON document on failure", async () => {
                expect.assertions(2);

                // No wrangler.jsonc → validation error.
                const { logger } = recordingLogger();

                const stdout = await captureStdout(async () => {
                    await runVerifyCommand({ cwd: workdir, format: "json", logger, typecheck: false });
                });

                const parsed = JSON.parse(stdout) as { code: number; errors: string[] };

                expect(parsed.code).toBe(1);
                expect(parsed.errors.length).toBeGreaterThan(0);
            });

            it("rejects an unknown --format the same way logs does", async () => {
                expect.assertions(3);

                const { logger, recorded } = recordingLogger();

                const stdout = await captureStdout(async () => {
                    const result = await runVerifyCommand({ cwd: workdir, format: "yaml", logger, typecheck: false });

                    expect(result.error).toBeDefined();
                });

                expect(stdout).toBe("");
                expect(recorded.errors.some((line) => line.includes('unknown --format "yaml" — expected pretty | json'))).toBe(true);
            });
        });
    });
});
