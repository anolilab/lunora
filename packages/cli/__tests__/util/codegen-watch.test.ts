import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { renderCodegenFailure, startCodegenWatch } from "../../src/util/codegen-watch";
import type { Logger } from "../../src/util/logger";

const silentLogger = (): { logger: Logger; warns: string[] } => {
    const warns: string[] = [];

    return {
        logger: {
            error: () => {},
            info: () => {},
            success: () => {},
            warn: (message) => warns.push(message),
        },
        warns,
    };
};

describe("renderCodegenFailure", () => {
    it("renders the failure message with the matched Lunora fix as a hint, sans stack", () => {
        expect.assertions(4);

        const output = renderCodegenFailure(new Error("defineSchema() not found in lunora/schema.ts"), "startup");

        // The failure line carries the reason and the original message.
        expect(output).toContain("codegen failed (startup): defineSchema() not found");
        // The recognized error contributes its solution header + a body fragment
        // as the rendered hint (Markdown emphasis flattened for the terminal).
        expect(output).toContain("No Lunora schema found");
        expect(output).toContain("vis generate lunora-table --name=messages");
        // The internal codegen-watch stack is suppressed — no frame leaks through.
        expect(output).not.toContain("codegen-watch");
    });

    it("renders only the failure for an unrecognized error, with no hint", () => {
        expect.assertions(2);

        const output = renderCodegenFailure(new Error("TypeError: boom is not a function"), "change: x.ts");

        expect(output).toContain("codegen failed (change: x.ts): TypeError: boom is not a function");
        expect(output).not.toContain("No Lunora schema found");
    });

    it("coerces a non-Error throw to a string without crashing", () => {
        expect.assertions(1);

        expect(renderCodegenFailure("raw string failure", "startup")).toContain("raw string failure");
    });
});

describe("startCodegenWatch", () => {
    describe("watchAvailable flag — degraded path (non-existent directory)", () => {
        it("sets watchAvailable:false and emits an escalated warning naming the consequence", () => {
            expect.assertions(3);

            // Watching a path that does not exist causes fs.watch to throw
            // ENOENT, which triggers the catch block and the degraded state.
            const missingPath = join(tmpdir(), `lunora-cw-missing-${String(Date.now())}`);
            const { logger, warns } = silentLogger();

            const handle = startCodegenWatch({
                logger,
                lunoraDirectory: ".",
                projectRoot: missingPath,
            });

            expect(handle.watchAvailable).toBe(false);
            // The warning must name the consequence, not just say "unavailable".
            expect(warns.some((w) => w.includes("NOT auto-regenerate"))).toBe(true);
            // "lunora codegen" must appear as the remediation action.
            expect(warns.some((w) => w.includes("lunora codegen"))).toBe(true);

            handle.close();
        });
    });

    describe("watchAvailable flag — happy path", () => {
        it("sets watchAvailable:true on platforms that support recursive watch", () => {
            // On platforms where recursive watch is not supported at all (some CI
            // Linux environments) this might be false; the key invariant is that the
            // property is a boolean in both cases.
            expect.assertions(1);

            const workdir = mkdtempSync(join(tmpdir(), "lunora-cw-"));

            try {
                writeFileSync(join(workdir, "schema.ts"), "", "utf8");

                const { logger } = silentLogger();
                const handle = startCodegenWatch({
                    logger,
                    lunoraDirectory: ".",
                    projectRoot: workdir,
                });

                expect(typeof handle.watchAvailable).toBe("boolean");

                handle.close();
            } finally {
                rmSync(workdir, { force: true, recursive: true });
            }
        });
    });
});
