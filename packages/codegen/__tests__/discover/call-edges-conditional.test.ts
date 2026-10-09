import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverCallEdges from "../../src/discover/call-edges";

let workdir: string;

/** The `conditional` flag of every schedule edge in `body`, the handler of an exported `tick`. */
const conditionalOf = (body: string): (true | undefined)[] => {
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

    return discoverCallEdges(new Project({ skipAddingFilesFromTsConfig: true }), join(workdir, "lunora"))
        .filter((edge) => edge.kind === "schedule")
        .map((edge) => edge.conditional);
};

const RESCHEDULE = "await ctx.scheduler.runAfter(1000, internal.tick.tick, {});";

describe("call edge `conditional`", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-call-edges-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("leaves a straight-line call unflagged — the key is absent, not `false`", () => {
        expect.assertions(2);

        expect(conditionalOf(RESCHEDULE)).toStrictEqual([undefined]);

        const [edge] = discoverCallEdges(new Project({ skipAddingFilesFromTsConfig: true }), join(workdir, "lunora"));

        expect(edge).not.toHaveProperty("conditional");
    });

    it.each([
        ["an if branch", `if (args.more) { ${RESCHEDULE} }`],
        ["an else branch", `if (args.done) { return; } else { ${RESCHEDULE} }`],
        ["a loop body", `for (const id of args.ids) { ${RESCHEDULE} }`],
        ["a try block", `try { ${RESCHEDULE} } catch { return; }`],
        ["a switch arm", `switch (args.state) { case "open": ${RESCHEDULE} }`],
        ["the right of &&", `args.more && (await ctx.scheduler.runAfter(1000, internal.tick.tick, {}));`],
        ["the right of ??", `args.next ?? (await ctx.scheduler.runAfter(1000, internal.tick.tick, {}));`],
        ["a ternary arm", `args.more ? await ctx.scheduler.runAfter(1000, internal.tick.tick, {}) : undefined;`],
        ["an optional call", `await ctx.scheduler?.runAfter(1000, internal.tick.tick, {});`],
        ["a statement after an early return", `if (args.done) return;\n${RESCHEDULE}`],
        ["a callback nested in the handler", `args.ids.forEach(async () => { ${RESCHEDULE} });`],
    ])("flags a call inside %s", (_label, body) => {
        expect.assertions(1);

        expect(conditionalOf(body)).toStrictEqual([true]);
    });

    it("does not treat a ternary's condition as guarded", () => {
        expect.assertions(1);

        expect(conditionalOf(`(await ctx.scheduler.runAfter(1000, internal.tick.tick, {})) ? 1 : 2;`)).toStrictEqual([undefined]);
    });

    it("does not treat the left operand of && as guarded", () => {
        expect.assertions(1);

        expect(conditionalOf(`(await ctx.scheduler.runAfter(1000, internal.tick.tick, {})) && args.more;`)).toStrictEqual([undefined]);
    });

    it("does not flag a call preceded only by plain statements", () => {
        expect.assertions(1);

        expect(conditionalOf(`const now = Date.now();\nvoid now;\n${RESCHEDULE}`)).toStrictEqual([undefined]);
    });
});
