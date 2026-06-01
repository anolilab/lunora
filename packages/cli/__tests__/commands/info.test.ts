import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runInfoCommand } from "../../src/commands/info.js";
import type { Logger } from "../../src/util/logger.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "..", "..", "codegen", "__tests__", "fixtures", "simple");

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

const PKG = `{
    "name": "demo",
    "dependencies": {
        "@cirrus/server": "^0.0.0",
        "@cirrus/runtime": "^0.0.0",
        "lodash": "^4.0.0"
    },
    "devDependencies": {
        "@cirrus/vite": "^0.0.0"
    }
}`;

const WRANGLER = `{
    "name": "demo-worker",
    "main": "cirrus/_generated/server.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "d1_databases": [{ "binding": "DB", "database_name": "db", "database_id": "id" }]
}`;

let workdir: string;

describe("cirrus info", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-cli-info-"));
        cpSync(join(fixtureRoot, "cirrus"), join(workdir, "cirrus"), { recursive: true });
        writeFileSync(join(workdir, "package.json"), PKG, "utf8");
        writeFileSync(join(workdir, "wrangler.jsonc"), WRANGLER, "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("cirrus info", () => {
        it("collects @cirrus/* packages, wrangler summary, and schema overview", () => {
            expect.hasAssertions();

            const { logger } = recordingLogger();

            const result = runInfoCommand({ cwd: workdir, logger });

            expect(result.code).toBe(0);

            const cirrusNames = result.snapshot.cirrusPackages.map((p) => p.name);

            expect(cirrusNames).toContain("@cirrus/server");
            expect(cirrusNames).toContain("@cirrus/runtime");
            expect(cirrusNames).toContain("@cirrus/vite");
            // Non-cirrus deps are excluded.
            expect(cirrusNames).not.toContain("lodash");

            expect(result.snapshot.wrangler?.name).toBe("demo-worker");
            expect(result.snapshot.wrangler?.bindings.durableObjects).toContain("SHARD");
            expect(result.snapshot.wrangler?.bindings.d1).toContain("DB");

            expect(result.snapshot.schema?.tables.length).toBeGreaterThan(0);
        });

        it("--json emits a machine-readable snapshot on stdout (jq-pipeable)", () => {
            expect.assertions(3);

            const { logger } = recordingLogger();
            const written: string[] = [];
            const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
                let text: string;

                if (typeof chunk === "string") {
                    text = chunk;
                } else if (Buffer.isBuffer(chunk)) {
                    text = chunk.toString("utf8");
                } else {
                    text = String(chunk);
                }

                written.push(text);

                return true;
            });

            try {
                const result = runInfoCommand({ cwd: workdir, json: true, logger });

                expect(result.code).toBe(0);

                // Stdout payload is just the JSON, no Pail prefixes — downstream
                // tools like `jq` can consume it verbatim.
                const payload = JSON.parse(written.join(""));

                expect(payload.cirrusPackages?.length).toBeGreaterThan(0);
                expect(payload.wrangler?.name).toBe("demo-worker");
            } finally {
                spy.mockRestore();
            }
        });

        it("missing wrangler is reported but does not fail", () => {
            expect.assertions(3);

            rmSync(join(workdir, "wrangler.jsonc"));
            const { logger, recorded } = recordingLogger();

            const result = runInfoCommand({ cwd: workdir, logger });

            expect(result.code).toBe(0);
            expect(result.snapshot.wrangler).toBeUndefined();
            expect(recorded.infos.join("\n")).toContain("wrangler: (not found)");
        });
    });
});
