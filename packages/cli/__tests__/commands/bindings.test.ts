import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runBindingsCommand } from "../../src/commands/bindings/handler";
import type { Logger } from "../../src/util/logger";

const recordingLogger = (): { errors: string[]; lines: string[]; logger: Logger; warns: string[] } => {
    const errors: string[] = [];
    const lines: string[] = [];
    const warns: string[] = [];

    return {
        errors,
        lines,
        logger: {
            error: (message) => errors.push(message),
            info: (message) => lines.push(message),
            success: (message) => lines.push(message),
            warn: (message) => warns.push(message),
        },
        warns,
    };
};

let workdir: string;

const writeWrangler = (config: Record<string, unknown>): void => {
    writeFileSync(join(workdir, "wrangler.jsonc"), JSON.stringify({ compatibility_date: "2026-01-01", main: "src/index.ts", name: "app", ...config }), "utf8");
};

describe("lunora bindings", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-bindings-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("lists what the Worker needs without running anything", () => {
        expect.assertions(3);

        // The point of the command: the manifest is a pure function of the
        // project, so a supervisor planning its graph should not have to start a
        // dev server or produce a bundle to read it.
        writeWrangler({
            d1_databases: [{ binding: "DB", database_name: "app" }],
            r2_buckets: [{ binding: "FILES", bucket_name: "uploads" }],
            triggers: { crons: ["0 9 * * *"] },
        });

        const { lines, logger } = recordingLogger();
        const { code } = runBindingsCommand({ cwd: workdir, logger });
        const output = lines.join("\n");

        expect(code).toBe(0);
        expect(output).toContain("DB");
        expect(output).toContain("0 9 * * *");
    });

    it("names vars without ever printing their values", () => {
        expect.assertions(2);

        // This is what lets the same document be written into a working tree
        // unasked — it must stay names-only.
        writeWrangler({ vars: { PUBLIC_URL: "https://example.test", SECRET_ISH: "hunter2" } });

        const { lines, logger } = recordingLogger();

        runBindingsCommand({ cwd: workdir, logger });

        const output = lines.join("\n");

        expect(output).toContain("SECRET_ISH");
        expect(output).not.toContain("hunter2");
    });

    it("emits the machine-readable manifest under --json", () => {
        expect.assertions(2);

        writeWrangler({ kv_namespaces: [{ binding: "CACHE", id: "abc123" }] });

        const { logger } = recordingLogger();
        let captured = "";
        const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
            captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");

            return true;
        });

        try {
            runBindingsCommand({ cwd: workdir, json: true, logger });
        } finally {
            spy.mockRestore();
        }

        const manifest = JSON.parse(captured) as { bindings: { binding: string; type: string }[] };

        expect(manifest.bindings).toHaveLength(1);
        expect(manifest.bindings[0]?.binding).toBe("CACHE");
    });

    it("writes the manifest to a file with --out", () => {
        expect.assertions(2);

        writeWrangler({ d1_databases: [{ binding: "DB", database_name: "app" }] });

        const destination = join(workdir, "nested", "reqs.json");
        const { logger } = recordingLogger();
        const { code } = runBindingsCommand({ cwd: workdir, logger, out: destination });
        const manifest = JSON.parse(readFileSync(destination, "utf8")) as { bindings: { binding: string }[] };

        expect(code).toBe(0);
        expect(manifest.bindings.map((binding) => binding.binding)).toStrictEqual(["DB"]);
    });

    it("fails rather than reporting a project with no wrangler config needs nothing", () => {
        expect.assertions(2);

        // "No bindings" and "I could not tell" must not look the same: a
        // deployer acts on the first by provisioning nothing.
        const { errors, logger } = recordingLogger();
        const { code } = runBindingsCommand({ cwd: workdir, logger });

        expect(code).toBe(1);
        expect(errors.join(" ")).toContain("no readable wrangler config");
    });
});
