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
        ["a catch clause", `try { await ctx.db.get(args.id); } catch { ${RESCHEDULE} }`],
        ["a switch arm", `switch (args.state) { case "open": ${RESCHEDULE} }`],
        ["the right of &&", `args.more && (await ctx.scheduler.runAfter(1000, internal.tick.tick, {}));`],
        ["the right of ??", `args.next ?? (await ctx.scheduler.runAfter(1000, internal.tick.tick, {}));`],
        ["a ternary arm", `args.more ? await ctx.scheduler.runAfter(1000, internal.tick.tick, {}) : undefined;`],
        ["an optional call", `await ctx.scheduler?.runAfter(1000, internal.tick.tick, {});`],
        ["a statement after an early return", `if (args.done) return;\n${RESCHEDULE}`],
        ["a callback nested in the handler", `args.ids.forEach(async () => { ${RESCHEDULE} });`],
        ["a statement after a return inside a try", `try { if (!args.id) return; } catch { return; }\n${RESCHEDULE}`],
        ["a statement after a return inside a switch", `switch (args.state) { case "done": return; }\n${RESCHEDULE}`],
        ["a statement after a return inside a nested block", `{ if (args.done) return; }\n${RESCHEDULE}`],
        ["a statement after a labeled block that may return", `check: { if (args.ok) break check; return; }\n${RESCHEDULE}`],
        ["an argument of an optional call", `args.logger?.info(await ctx.scheduler.runAfter(1000, internal.tick.tick, {}));`],
        ["a schedule whose id is kept for cancelling", `const id = await ctx.scheduler.runAfter(1000, internal.tick.tick, {});\nvoid id;`],
        ["a schedule a later throw rolls back", `${RESCHEDULE}\nif (!(await ctx.db.get(args.id))) throw new Error("gone");`],
    ])("flags a call inside %s", (_label, body) => {
        expect.assertions(1);

        expect(conditionalOf(body)).toStrictEqual([true]);
    });

    it.each([
        ["a try block", `try { ${RESCHEDULE} } catch { return; }`],
        ["a finally block", `try { await ctx.db.get(args.id); } finally { ${RESCHEDULE} }`],
        ["a do body, which runs at least once", `do { ${RESCHEDULE} } while (args.more);`],
        ["an if condition", `if (await ctx.scheduler.runAfter(1000, internal.tick.tick, {})) { void 0; }`],
        ["a statement after a batch loop with no exit", `for (const id of args.ids) { await ctx.db.get(id); }\n${RESCHEDULE}`],
        ["a statement after an if that never exits", `if (args.verbose) console.log("tick");\n${RESCHEDULE}`],
        ["a statement after a switch that only breaks", `switch (args.state) { case "a": break; }\n${RESCHEDULE}`],
        ["a returned schedule", `return await ctx.scheduler.runAfter(1000, internal.tick.tick, {});`],
        ["a schedule followed by a throw in a nested callback", `${RESCHEDULE}\nargs.ids.forEach(() => { throw new Error("x"); });`],
    ])("does not flag a call in %s", (_label, body) => {
        expect.assertions(1);

        expect(conditionalOf(body)).toStrictEqual([undefined]);
    });

    it("reads a string dispatch key as the schedule's target", () => {
        expect.assertions(1);

        conditionalOf(`await ctx.scheduler.runAfter(1000, "tick:tick", {});`);

        expect(discoverCallEdges(new Project({ skipAddingFilesFromTsConfig: true }), join(workdir, "lunora"))).toMatchObject([
            { kind: "schedule", target: "tick:tick" },
        ]);
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
