import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runBackupCommand } from "../../src/commands/backup/handler";
import { runContainersCommand } from "../../src/commands/containers/handler";
import { runExportCommand } from "../../src/commands/data-transfer";
import { runDeploymentsCommand } from "../../src/commands/deployments/handler";
import { runEnvCommand } from "../../src/commands/env/handler";
import { runRpcCommand } from "../../src/commands/run/handler";
import { runSeedCommand } from "../../src/commands/seed/handler";
import type { Logger } from "../../src/util/logger";
import { createRecordingSpawner } from "../../src/util/spawn";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const commandsDirectory = join(testDirectory, "..", "..", "src", "commands");

/** A logger that records instead of writing, so a suite can assert on human output. */
const recordingLogger = (): { lines: string[]; logger: Logger } => {
    const lines: string[] = [];

    return {
        lines,
        logger: {
            error: (message) => lines.push(message),
            info: (message) => lines.push(message),
            success: (message) => lines.push(message),
            warn: (message) => lines.push(message),
        },
    };
};

/** Run `body` with `process.stdout.write` captured, and return what it wrote. */
const captureStdout = async (body: () => Promise<void>): Promise<string> => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
        chunks.push(String(chunk));

        return true;
    });

    try {
        await body();
    } finally {
        spy.mockRestore();
    }

    return chunks.join("");
};

/** Every command-metadata module (`<command>/index.ts`, plus registry's `command.ts`). */
const commandMetadataFiles = (): string[] => {
    const files: string[] = [];

    for (const entry of readdirSync(commandsDirectory)) {
        const directory = join(commandsDirectory, entry);

        if (!statSync(directory).isDirectory()) {
            continue;
        }

        for (const candidate of ["index.ts", "command.ts"]) {
            const file = join(directory, candidate);

            try {
                if (statSync(file).isFile() && readFileSync(file, "utf8").includes("options:")) {
                    files.push(join(entry, candidate));
                }
            } catch {
                // The module does not exist for this command — nothing to check.
            }
        }
    }

    return files;
};

const SCHEMA_SOURCE = `import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";

export default defineSchema({
    notes: defineTable({
        body: v.string(),
    }),
});
`;

let workdir: string;

describe("--format pretty|json is the one machine-readable flag", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-format-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
        vi.restoreAllMocks();
    });

    // The point of the normalization: an agent memorizes ONE spelling. `dev` is
    // the single, deliberate exception — its `--json` selects a streaming
    // log-line format for a long-running process, not a result document, so
    // folding it in would give `--format json` two incompatible meanings.
    it("declares a bare `--json` boolean on dev and nowhere else", () => {
        expect.assertions(1);

        // Matched on the option NAME, not a one-line spelling: the declaration is
        // free to grow a comment and wrap, and this gate has to keep seeing it.
        const withJsonBoolean = commandMetadataFiles().filter((file) => /name:\s*"json"/u.test(readFileSync(join(commandsDirectory, file), "utf8")));

        expect(withJsonBoolean).toStrictEqual([join("dev", "index.ts")]);
    });

    it("env list answers with the key names as a single document", async () => {
        expect.assertions(3);

        writeFileSync(join(workdir, ".dev.vars"), 'A="1"\nB="2"\n', "utf8");

        const { logger } = recordingLogger();
        let code = -1;

        const stdout = await captureStdout(async () => {
            ({ code } = await runEnvCommand({ cwd: workdir, format: "json", logger, subcommand: "list" }));
        });

        expect(code).toBe(0);

        const document = JSON.parse(stdout) as { keys: string[]; subcommand: string };

        expect(document.subcommand).toBe("list");
        // Names, never values — `list` redacts in pretty mode too.
        expect(document.keys).toStrictEqual(["A", "B"]);
    });

    it("env doctor answers with the missing / placeholder / extra split", async () => {
        expect.assertions(3);

        writeFileSync(join(workdir, ".dev.vars.example"), "NEEDED=\n", "utf8");
        writeFileSync(join(workdir, ".dev.vars"), 'OTHER="x"\n', "utf8");

        const { logger } = recordingLogger();
        let code = -1;

        const stdout = await captureStdout(async () => {
            ({ code } = await runEnvCommand({ cwd: workdir, format: "json", logger, subcommand: "doctor" }));
        });

        expect(code).toBe(1);

        const document = JSON.parse(stdout) as { extra: string[]; missing: string[]; ok: boolean };

        expect(document.missing).toStrictEqual(["NEEDED"]);
        expect(document.ok).toBe(false);
    });

    it("rejects an unknown --format before doing anything", async () => {
        expect.assertions(2);

        const { lines, logger } = recordingLogger();
        const { code } = await runEnvCommand({ cwd: workdir, format: "xml", logger, subcommand: "list" });

        expect(code).toBe(1);
        expect(lines).toContain('env: unknown --format "xml" — expected pretty | json');
    });

    it("seed --dry-run carries the generated rows as an array instead of an NDJSON stream", async () => {
        expect.assertions(4);

        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "lunora", "schema.ts"), SCHEMA_SOURCE, "utf8");

        const { logger } = recordingLogger();
        let code = -1;

        const stdout = await captureStdout(async () => {
            ({ code } = await runSeedCommand({ count: 2, cwd: workdir, dryRun: true, format: "json", logger, seed: 1 }));
        });

        expect(code).toBe(0);

        const document = JSON.parse(stdout) as { generated: number; inserted: number; rows: { table: string }[] };

        expect(document.generated).toBe(2);
        expect(document.inserted).toBe(0);
        expect(document.rows.map((row) => row.table)).toStrictEqual(["notes", "notes"]);
    });

    it("export refuses --format json when stdout already carries the NDJSON stream", async () => {
        expect.assertions(2);

        const { lines, logger } = recordingLogger();
        const result = await runExportCommand({ cwd: workdir, format: "json", logger, out: "-" });

        expect(result.code).toBe(1);
        expect(lines.join("\n")).toContain("export --format json needs a file destination");
    });

    it("deployments refuses --format json on a subcommand wrangler cannot answer as JSON", async () => {
        expect.assertions(2);

        const { logger } = recordingLogger();
        const { spawner } = createRecordingSpawner(0);
        const result = await runDeploymentsCommand({ cwd: workdir, format: "json", logger, spawner, subcommand: "rollback", yes: true });

        expect(result.code).toBe(1);
        expect(result.error).toContain("only available for `deployments list`");
    });

    it("containers forwards --json to the read subcommands and refuses it on the rest", async () => {
        expect.assertions(4);

        const { logger } = recordingLogger();
        const { calls, spawner } = createRecordingSpawner(0);

        const listed = await runContainersCommand({ argument: ["list"], cwd: workdir, format: "json", logger, spawner });

        expect(listed.code).toBe(0);
        expect(listed.descriptor?.args).toContain("--json");

        const built = await runContainersCommand({
            argument: ["build", "."],
            cwd: workdir,
            dockerAvailable: () => true,
            format: "json",
            logger,
            spawner,
        });

        expect(built.code).toBe(1);
        // The refused build never spawned, so only `list` was recorded.
        expect(calls).toHaveLength(1);
    });

    it("run emits the RPC result as the document", async () => {
        expect.assertions(3);

        const { logger } = recordingLogger();
        let code = -1;

        const stdout = await captureStdout(async () => {
            ({ code } = await runRpcCommand({
                cwd: workdir,
                fetchImpl: () =>
                    Promise.resolve({
                        json: () => Promise.resolve({ result: 42 }),
                        ok: true,
                        status: 200,
                        text: () => Promise.resolve(JSON.stringify({ result: 42 })),
                    }),
                format: "json",
                functionPath: "notes:list",
                logger,
                url: "http://localhost:8787",
            }));
        });

        expect(code).toBe(0);

        const document = JSON.parse(stdout) as { functionPath: string; result: { result: number } };

        expect(document.functionPath).toBe("notes:list");
        expect(document.result.result).toBe(42);
    });

    it("backup list answers with the manifest entries", async () => {
        expect.assertions(2);

        const { logger } = recordingLogger();
        let code = -1;

        const stdout = await captureStdout(async () => {
            ({ code } = await runBackupCommand({ cwd: workdir, format: "json", logger, subcommand: "list" }));
        });

        expect(code).toBe(0);
        expect(JSON.parse(stdout)).toStrictEqual({ entries: [], ok: true, subcommand: "list" });
    });
});
