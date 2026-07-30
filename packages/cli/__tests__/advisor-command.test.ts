import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runAdvisorCommand } from "../src/commands/advisor/handler";
import type { Logger } from "../src/util/logger";

/** A logger that records rather than prints, so assertions can read the output. */
const recordingLogger = (): { lines: string[]; logger: Logger } => {
    const lines: string[] = [];
    const push = (message: string) => {
        lines.push(message);
    };

    return { lines, logger: { debug: push, error: push, info: push, log: push, success: push, warn: push } as unknown as Logger };
};

/** A schema whose `posts.authorId` FK has no index — one guaranteed project-level finding. */
const SCHEMA = `import { defineSchema, defineTable, v } from "@lunora/server";
export const schema = defineSchema({
    users: defineTable({ name: v.string() }),
    posts: defineTable({ authorId: v.id("users"), title: v.string() }).relations((r) => ({
        author: r.one("users", { field: "authorId" }),
    })),
});
`;

describe("lunora advisor", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-advisor-cmd-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "lunora", "schema.ts"), SCHEMA, "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
        vi.restoreAllMocks();
    });

    it("scores the project and writes the map artifact", () => {
        expect.assertions(4);

        const { logger } = recordingLogger();
        const result = runAdvisorCommand({ cwd: workdir, logger });

        expect(result.error).toBeUndefined();
        expect(result.map?.grade).toBeDefined();
        expect(result.written).toBe(join(workdir, "lunora.advisor.map.json"));

        const onDisk = JSON.parse(readFileSync(join(workdir, "lunora.advisor.map.json"), "utf8"));

        expect(onDisk.version).toBe(result.map?.version);
    });

    it("honours --no-write", () => {
        expect.assertions(2);

        const { logger } = recordingLogger();
        const result = runAdvisorCommand({ cwd: workdir, logger, noWrite: true });

        expect(result.written).toBeUndefined();
        expect(() => readFileSync(join(workdir, "lunora.advisor.map.json"), "utf8")).toThrow(/ENOENT/u);
    });

    it("renders a summary naming the score and grade", () => {
        expect.assertions(2);

        const { lines, logger } = recordingLogger();

        runAdvisorCommand({ cwd: workdir, logger, noWrite: true });

        const output = lines.join("\n");

        expect(output).toContain("advisor health");
        expect(output).toMatch(/clean · .* warned · .* failing/u);
    });

    it("rejects a --min-score outside 0-100 rather than silently skipping the gate", () => {
        expect.assertions(1);

        const { logger } = recordingLogger();

        expect(runAdvisorCommand({ cwd: workdir, logger, minScore: 400, noWrite: true }).error).toContain("--min-score");
    });

    it("errors when a baseline was asked for but does not exist", () => {
        expect.assertions(1);

        const { logger } = recordingLogger();
        const result = runAdvisorCommand({ baseline: "", cwd: workdir, logger, noWrite: true });

        // A missing baseline must not read as "nothing regressed".
        expect(result.error).toContain("baseline not found");
    });

    it("errors on a baseline it cannot parse rather than passing the gate", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora.advisor.map.json"), JSON.stringify({ procedures: [null], score: 0, version: 1 }), "utf8");

        const { logger } = recordingLogger();

        expect(runAdvisorCommand({ baseline: "", cwd: workdir, logger, noWrite: true }).error).toContain("unreadable");
    });

    it("reports no regression when compared against its own output", () => {
        expect.assertions(2);

        const { logger } = recordingLogger();

        runAdvisorCommand({ cwd: workdir, logger });

        const result = runAdvisorCommand({ baseline: "", cwd: workdir, logger, noWrite: true });

        expect(result.comparison?.comparable).toBe(true);
        expect(result.comparison?.comparable === true && result.comparison.regressed).toBe(false);
    });

    it("detects a regression when new project debt lands after the baseline", () => {
        expect.assertions(1);

        const { logger } = recordingLogger();

        runAdvisorCommand({ cwd: workdir, logger });

        // Add a second unindexed FK — a fresh project-level finding.
        writeFileSync(
            join(workdir, "lunora", "schema.ts"),
            `import { defineSchema, defineTable, v } from "@lunora/server";
export const schema = defineSchema({
    users: defineTable({ name: v.string() }),
    posts: defineTable({ authorId: v.id("users"), title: v.string() }).relations((r) => ({
        author: r.one("users", { field: "authorId" }),
    })),
    comments: defineTable({ postId: v.id("posts"), body: v.string() }).relations((r) => ({
        post: r.one("posts", { field: "postId" }),
    })),
});
`,
            "utf8",
        );

        const result = runAdvisorCommand({ baseline: "", cwd: workdir, logger, noWrite: true });

        expect(result.comparison?.comparable === true && result.comparison.regressed).toBe(true);
    });

    it("inspects a single entry and explains an unknown one", () => {
        expect.assertions(1);

        const { lines, logger } = recordingLogger();

        runAdvisorCommand({ cwd: workdir, entry: "nope#missing", logger, noWrite: true });

        expect(lines.join("\n")).toContain("no procedure nope#missing");
    });
});
