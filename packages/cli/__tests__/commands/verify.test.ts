import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runVerifyCommand } from "../../src/commands/verify.js";
import type { Logger } from "../../src/util/logger.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "..", "..", "codegen", "__tests__", "fixtures", "simple");

const VALID_WRANGLER = `{
    "name": "cirrus-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "y" }]
}
`;

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

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "cirrus-cli-verify-"));
    cpSync(join(fixtureRoot, "cirrus"), join(workdir, "cirrus"), { recursive: true });
});

afterEach(() => {
    rmSync(workdir, { force: true, recursive: true });
});

describe("cirrus verify", () => {
    test("returns 0 and writes nothing when wrangler + codegen are both valid", () => {
        writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
        const { logger, recorded } = recordingLogger();

        const result = runVerifyCommand({ cwd: workdir, logger });

        expect(result.code).toBe(0);
        expect(result.errors).toEqual([]);
        expect(recorded.successes.join("\n")).toContain("valid");
        // Dry-run must not have created the _generated/ directory.
        expect(existsSync(join(workdir, "cirrus", "_generated"))).toBe(false);
    });

    test("returns 1 and surfaces wrangler errors", () => {
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

        const result = runVerifyCommand({ cwd: workdir, logger });

        expect(result.code).toBe(1);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(recorded.errors.join("\n")).toContain("errors:");
    });

    test("returns 1 when codegen discovery fails (broken schema)", () => {
        writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
        writeFileSync(join(workdir, "cirrus", "schema.ts"), "this is not valid typescript syntax {{{", "utf8");
        const { logger } = recordingLogger();

        const result = runVerifyCommand({ cwd: workdir, logger });

        expect(result.code).toBe(1);
        expect(result.errors.some((error) => error.includes("codegen failed"))).toBe(true);
    });

    test("returns 1 when wrangler.jsonc is missing", () => {
        const { logger } = recordingLogger();
        // No wrangler.jsonc written.
        const filesBefore = readdirSync(workdir);

        expect(filesBefore).not.toContain("wrangler.jsonc");

        const result = runVerifyCommand({ cwd: workdir, logger });

        expect(result.code).toBe(1);
        expect(result.errors.join("\n")).toContain("wrangler.jsonc");
    });
});
