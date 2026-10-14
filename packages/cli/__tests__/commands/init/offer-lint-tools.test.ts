import type { LintIgnoreOutcome, LintTool } from "@lunora/config";
import { describe, expect, it, vi } from "vitest";

import { LINT_TOOL_OPTIONS, offerLintTools } from "../../../src/commands/init/offer-lint-tools";
import type { Logger } from "../../../src/util/logger";

const recordingLogger = (): { logger: Logger; successes: string[]; warnings: string[] } => {
    const successes: string[] = [];
    const warnings: string[] = [];

    return {
        logger: { error: () => {}, info: () => {}, success: (message) => successes.push(message), warn: (message) => warnings.push(message) },
        successes,
        warnings,
    };
};

describe("offerLintTools", () => {
    it("configures exactly what the user picked", async () => {
        expect.assertions(3);

        const apply = vi.fn<(tools: ReadonlyArray<LintTool>) => LintIgnoreOutcome[]>(() => [{ path: ".prettierignore", status: "created", tool: "prettier" }]);
        const multiSelect = vi.fn<() => Promise<LintTool[]>>(async () => ["prettier"]);
        const { logger, successes } = recordingLogger();

        await offerLintTools({ apply, detected: [], interactive: true, logger, multiSelect });

        expect(multiSelect).toHaveBeenCalledTimes(1);
        expect(apply).toHaveBeenCalledWith(["prettier"]);
        expect(successes.join("\n")).toContain(".prettierignore");
    });

    it("pre-selects what the scaffolded project already declares", async () => {
        expect.assertions(1);

        // A template that ships Prettier shouldn't make the user re-state it —
        // the prompt confirms a detected answer rather than guessing.
        const multiSelect = vi.fn<() => Promise<LintTool[]>>(async () => ["prettier", "eslint"]);

        await offerLintTools({
            apply: () => [],
            detected: ["prettier"],
            interactive: true,
            logger: recordingLogger().logger,
            multiSelect,
        });

        expect(multiSelect).toHaveBeenCalledWith(expect.any(String), LINT_TOOL_OPTIONS, { defaults: ["prettier"] });
    });

    it("configures the detected tools without prompting when non-interactive", async () => {
        expect.assertions(2);

        // Scaffolding must never block automation on a question, and configuring
        // what was detected beats doing nothing.
        const apply = vi.fn<(tools: ReadonlyArray<LintTool>) => LintIgnoreOutcome[]>(() => []);
        const multiSelect = vi.fn<() => Promise<LintTool[]>>(async () => []);

        await offerLintTools({ apply, detected: ["biome"], interactive: false, logger: recordingLogger().logger, multiSelect });

        expect(multiSelect).not.toHaveBeenCalled();
        expect(apply).toHaveBeenCalledWith(["biome"]);
    });

    it("writes nothing when the user picks none", async () => {
        expect.assertions(1);

        const apply = vi.fn<(tools: ReadonlyArray<LintTool>) => LintIgnoreOutcome[]>(() => []);

        await offerLintTools({
            apply,
            detected: [],
            interactive: true,
            logger: recordingLogger().logger,
            multiSelect: async () => [],
        });

        expect(apply).not.toHaveBeenCalled();
    });

    it("prints the snippet for an eslint config it refused to rewrite", async () => {
        expect.assertions(2);

        const { logger, warnings } = recordingLogger();

        await offerLintTools({
            apply: () => [{ path: "eslint.config.js", snippet: "{ ignores: [...] }", status: "manual", tool: "eslint" }],
            detected: ["eslint"],
            interactive: false,
            logger,
            multiSelect: async () => [],
        });

        expect(warnings.join("\n")).toContain("eslint.config.js");
        expect(warnings.join("\n")).toContain("ignores");
    });
});
