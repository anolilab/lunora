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

    return { lines, logger: { debug: push, error: push, info: push, success: push, warn: push } };
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

/** The same schema plus a second unindexed FK — one more project-level finding. */
const REGRESSED_SCHEMA = `import { defineSchema, defineTable, v } from "@lunora/server";
export const schema = defineSchema({
    users: defineTable({ name: v.string() }),
    posts: defineTable({ authorId: v.id("users"), title: v.string() }).relations((r) => ({
        author: r.one("users", { field: "authorId" }),
    })),
    comments: defineTable({ postId: v.id("posts"), body: v.string() }).relations((r) => ({
        post: r.one("posts", { field: "postId" }),
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

    it("honours --write false", () => {
        expect.assertions(2);

        const { logger } = recordingLogger();
        const result = runAdvisorCommand({ cwd: workdir, logger, write: false });

        expect(result.written).toBeUndefined();
        expect(() => readFileSync(join(workdir, "lunora.advisor.map.json"), "utf8")).toThrow(/ENOENT/u);
    });

    it("renders a summary naming the score and grade", () => {
        expect.assertions(2);

        const { lines, logger } = recordingLogger();

        runAdvisorCommand({ cwd: workdir, logger, write: false });

        const output = lines.join("\n");

        expect(output).toContain("advisor health");
        expect(output).toMatch(/clean · .* warned · .* failing/u);
    });

    it("rejects a --min-score outside 0-100 rather than silently skipping the gate", () => {
        expect.assertions(1);

        const { logger } = recordingLogger();

        expect(runAdvisorCommand({ cwd: workdir, logger, minScore: 400, write: false }).error).toContain("--min-score");
    });

    it("errors when a baseline was asked for but does not exist", () => {
        expect.assertions(1);

        const { logger } = recordingLogger();
        const result = runAdvisorCommand({ baseline: "", cwd: workdir, logger, write: false });

        // A missing baseline must not read as "nothing regressed".
        expect(result.error).toContain("baseline not found");
    });

    it("errors on a baseline it cannot parse rather than passing the gate", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora.advisor.map.json"), JSON.stringify({ procedures: [null], score: 0, version: 1 }), "utf8");

        const { logger } = recordingLogger();

        expect(runAdvisorCommand({ baseline: "", cwd: workdir, logger, write: false }).error).toContain("malformed");
    });

    it("reports no regression when compared against its own output", () => {
        expect.assertions(2);

        const { logger } = recordingLogger();

        runAdvisorCommand({ cwd: workdir, logger });

        const result = runAdvisorCommand({ baseline: "", cwd: workdir, logger, write: false });

        expect(result.comparison?.comparable).toBe(true);
        expect(result.comparison?.comparable === true && result.comparison.regressed).toBe(false);
    });

    it("does not clobber the baseline it is gating against (writing is the default)", () => {
        expect.assertions(2);

        const { logger } = recordingLogger();

        runAdvisorCommand({ cwd: workdir, logger });

        const committed = readFileSync(join(workdir, "lunora.advisor.map.json"), "utf8");

        // Regress, then run the gate exactly as documented: `--baseline`, no --no-write.
        // `--baseline` and `--out` share a default path, so writing before reading
        // would overwrite the baseline and diff the map against itself — the gate
        // would report "no regression" forever.
        writeFileSync(join(workdir, "lunora", "schema.ts"), REGRESSED_SCHEMA, "utf8");

        const result = runAdvisorCommand({ baseline: "", cwd: workdir, logger });

        expect(result.comparison?.comparable === true && result.comparison.regressed).toBe(true);
        expect(readFileSync(join(workdir, "lunora.advisor.map.json"), "utf8")).not.toBe(committed);
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

        const result = runAdvisorCommand({ baseline: "", cwd: workdir, logger, write: false });

        expect(result.comparison?.comparable === true && result.comparison.regressed).toBe(true);
    });

    it.each([
        ["a valueless flag (cerebro yields null)", null],
        ["an unset CI variable", ""],
    ])("refuses --min-score given %s rather than gating at zero", (_label, raw) => {
        expect.assertions(1);

        const { logger } = recordingLogger();

        // `Number(null)` and `Number("")` are both 0, and `score < 0` is never true —
        // so coercing first would silently disable the gate.
        expect(runAdvisorCommand({ cwd: workdir, logger, minScore: raw, write: false }).error).toContain("--min-score");
    });

    it("treats a valueless --baseline as the default path instead of crashing", () => {
        expect.assertions(1);

        const { logger } = recordingLogger();

        runAdvisorCommand({ cwd: workdir, logger });

        // cerebro hands `--baseline` with no value through as `null`.
        expect(runAdvisorCommand({ baseline: null, cwd: workdir, logger, write: false }).comparison?.comparable).toBe(true);
    });

    it("fails the run when the score is below --min-score", () => {
        expect.assertions(2);

        const { logger } = recordingLogger();
        const pass = runAdvisorCommand({ cwd: workdir, logger, minScore: 0, write: false });
        const fail = runAdvisorCommand({ cwd: workdir, logger, minScore: 100, write: false });

        expect(pass.belowMinScore).toBe(false);
        expect(fail.belowMinScore).toBe(true);
    });

    it("writes a byte-stable artifact so a committed baseline does not churn", () => {
        expect.assertions(1);

        const { logger } = recordingLogger();

        runAdvisorCommand({ cwd: workdir, logger });

        const first = readFileSync(join(workdir, "lunora.advisor.map.json"), "utf8");

        runAdvisorCommand({ cwd: workdir, logger });

        // A wall-clock stamp would leave the committed map dirty after every run.
        expect(readFileSync(join(workdir, "lunora.advisor.map.json"), "utf8")).toBe(first);
    });

    it("inspects a single entry and explains an unknown one", () => {
        expect.assertions(1);

        const { lines, logger } = recordingLogger();

        runAdvisorCommand({ cwd: workdir, entry: "nope#missing", logger, write: false });

        expect(lines.join("\n")).toContain("no procedure nope#missing");
    });
});
