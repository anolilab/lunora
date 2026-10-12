import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverCallEdges from "../../src/discover/call-edges";

let workdir: string;

/** The schedule edges discovered in `body`, the handler of an exported `tick`. */
const schedulesOf = (body: string) => {
    writeFileSync(
        join(workdir, "lunora", "tick.ts"),
        `import { internalMutation } from "@lunora/server";
import { internal } from "./_generated/api";

export const tick = internalMutation({
    handler: async (ctx, args) => {
${body}
    },
});
`,
        "utf8",
    );

    return discoverCallEdges(new Project({ skipAddingFilesFromTsConfig: true }), join(workdir, "lunora")).filter((edge) => edge.kind === "schedule");
};

describe("schedule edge delay and cursor facts", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-schedule-facts-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reads the literal delay of a runAfter", () => {
        expect.assertions(1);

        expect(schedulesOf("await ctx.scheduler.runAfter(100, internal.tick.tick, {});")[0]).toMatchObject({
            schedule: { argKeys: [], delayMs: 100 },
            target: "tick:tick",
        });
    });

    it("leaves the delay absent for runAt and for a non-literal delay", () => {
        expect.assertions(2);

        expect(schedulesOf("await ctx.scheduler.runAt(Date.now(), internal.tick.tick, {});")[0]?.schedule?.delayMs).toBeUndefined();
        expect(schedulesOf("await ctx.scheduler.runAfter(args.wait, internal.tick.tick, {});")[0]?.schedule?.delayMs).toBeUndefined();
    });

    it("records the top-level arg keys of an object-literal args value", () => {
        expect.assertions(2);

        expect(schedulesOf("await ctx.scheduler.runAfter(100, internal.tick.tick, { cursor: args.cursor, limit: 5 });")[0]?.schedule?.argKeys).toStrictEqual([
            "cursor",
            "limit",
        ]);
        expect(schedulesOf("await ctx.scheduler.runAfter(100, internal.tick.tick, {});")[0]?.schedule?.argKeys).toStrictEqual([]);
    });

    it("leaves the arg keys unknown when the args are not an object literal, or spread one", () => {
        expect.assertions(2);

        expect(schedulesOf("await ctx.scheduler.runAfter(100, internal.tick.tick, args);")[0]?.schedule?.argKeys).toBeUndefined();
        expect(schedulesOf("await ctx.scheduler.runAfter(100, internal.tick.tick, { ...args });")[0]?.schedule?.argKeys).toBeUndefined();
    });

    it("reads the keys of a const args object the dispatch names, and not of a let", () => {
        expect.assertions(2);

        expect(
            schedulesOf("const next = { cursor: args.cursor };\n        await ctx.scheduler.runAfter(100, internal.tick.tick, next);")[0]?.schedule?.argKeys,
        ).toStrictEqual(["cursor"]);
        // A `let` can be reassigned before the dispatch, so its keys are not evidence.
        expect(
            schedulesOf("let next = { cursor: 1 };\n        await ctx.scheduler.runAfter(100, internal.tick.tick, next);")[0]?.schedule?.argKeys,
        ).toBeUndefined();
    });
});
