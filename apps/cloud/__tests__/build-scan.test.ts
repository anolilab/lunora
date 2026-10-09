import { describe, expect, it } from "vitest";

/**
 * The build box's bundle scan (`containers/build/scan.mjs`) — the analysis half.
 *
 * The case tables are the codegen analyses' own (`discover/unbounded-loops` and
 * the `conditional` table of `discover/call-edges`), ported from ts-morph to the
 * acorn walk, so the two keep agreeing on what an exit and a guard are. Two
 * deliberate differences, each pinned below:
 *
 * - A loop in a class method IS reported here. Codegen skips it because its
 *   attribution cannot place a class method; the bundle has no such limit, and
 *   a Durable Object's `alarm()` is exactly where the expensive one lives.
 * - The call-edge table's sense is inverted: "flags a call as conditional"
 *   there means "guarded", which here means NOT reported.
 */

interface RawFinding {
    binding?: string;
    column: number;
    line: number;
    loopKind?: string;
    name: string;
    queue?: string;
}

interface ScanModule {
    analyzeSource: (code: string, options?: { deadline?: number; manifest?: unknown; now?: () => number }) => RawFinding[];
}

// Loaded by URL: the module is plain `.mjs` shipped into the image, with no
// declaration file for the type checker to resolve.
const { analyzeSource } = (await import(new URL("../containers/build/scan.mjs", import.meta.url).href)) as ScanModule;

const names = (code: string, manifest?: unknown): string[] => analyzeSource(code, { manifest }).map((finding) => finding.name);

/** A function body, the way the codegen tables wrap theirs. */
const inFunction = (body: string): string => `export const run = async (ctx, ids, signal) => {\n${body}\n};\n`;

describe("unbounded_loop", () => {
    it.each([
        ["a bare while (true) around an await", "while (true) {\n    const row = await ctx.db.first();\n    void row;\n}"],
        ["for (;;)", "for (;;) {\n    await ctx.storage.put('k', 1);\n}"],
        ["for (; true;)", "for (; true;) {\n    await ctx.storage.put('k', 1);\n}"],
        ["do { … } while (true)", "do {\n    await ctx.storage.put('k', 1);\n} while (true);"],
        ["a parenthesised while ((true))", "while ((true)) {\n    await ctx.storage.put('k', 1);\n}"],
        ["a minified while (!0)", "while (!0) { ctx.n++; }"],
        ["a loop whose only return is in a nested callback", "const stop = () => {\n    return;\n};\nwhile (true) {\n    void stop;\n}"],
        ["a continue to the loop itself", "while (true) { continue; }"],
        ["a labeled continue to the loop itself", "spin: while (true) { continue spin; }"],
        ["a break out of a nested switch", "while (true) { switch (ids.length) { case 0: break; } }"],
        ["a break out of a nested loop", "while (true) { for (const id of ids) { if (id) break; } }"],
        ["a loop where only a nested generator yields", "while (true) {\n    const inner = function* () {\n        yield 1;\n    };\n    void inner;\n}"],
    ])("reports %s", (_label, body) => {
        expect.assertions(1);

        expect(names(inFunction(body))).toStrictEqual(["unbounded_loop"]);
    });

    it("reports a module-scope loop — the worker hangs at import time", () => {
        expect.assertions(1);

        expect(analyzeSource("while (true) {\n    const never = 1;\n    void never;\n}\n")).toMatchObject([
            { line: 1, loopKind: "while (true)", name: "unbounded_loop" },
        ]);
    });

    it("reports a loop in a top-level helper", () => {
        expect.assertions(1);

        expect(names("const pumpForever = () => {\n    while (true) {\n        void 1;\n    }\n};\nexport const start = () => pumpForever();\n")).toStrictEqual(
            ["unbounded_loop"],
        );
    });

    it("reports a loop in a class method — unlike codegen, which cannot place one", () => {
        expect.assertions(1);

        // The incident shape: a Durable Object alarm spinning on storage.
        expect(
            analyzeSource(
                "export class Room {\n    async alarm() {\n        while (true) {\n            await this.ctx.storage.put('n', 1);\n        }\n    }\n}\n",
            ),
        ).toMatchObject([{ line: 3, name: "unbounded_loop" }]);
    });

    it("names the loop form in the finding", () => {
        expect.assertions(1);

        const kinds = analyzeSource(inFunction("while (true) {}\nfor (;;) {}\ndo {} while (true);")).map((finding) => finding.loopKind);

        expect(kinds).toStrictEqual(["while (true)", "for (;;)", "do … while (true)"]);
    });

    it.each([
        ["a break", "let done = false;\nwhile (true) {\n    if (done) {\n        break;\n    }\n}"],
        [
            "a labeled break from a nested loop",
            "let found = false;\nouter: while (true) {\n    for (;;) {\n        if (found) {\n            break outer;\n        }\n    }\n}",
        ],
        ["a labeled break to a label wrapping the loop itself", "spin: while (true) { break spin; }"],
        ["a return", "while (true) {\n    if (Date.now() > 1) {\n        return;\n    }\n}"],
        ["a throw", 'while (true) {\n    throw new Error("no");\n}'],
        ["a labeled continue to an outer loop", "outer: for (const id of ids) { while (true) { if (id) continue outer; } }"],
        ["a labeled break out of a wrapping block", "done: { while (true) { break done; } }"],
        ["an abort-signal check", "while (true) { signal.throwIfAborted(); }"],
        ["an optional abort-signal check", "while (true) { signal?.throwIfAborted(); }"],
        ["a return inside a try", "while (true) { try { return; } finally { void 0; } }"],
        ["a condition that may become false", "let left = 10;\nwhile (left > 0) {\n    left -= 1;\n}"],
    ])("does not report a loop left by %s", (_label, body) => {
        expect.assertions(1);

        expect(names(inFunction(body))).toStrictEqual([]);
    });

    it("does not report a generator that yields from the loop", () => {
        expect.assertions(1);

        expect(
            names(
                "function* sequence() {\n    let next = 0;\n\n    while (true) {\n        yield next++;\n    }\n}\nexport const first = () => sequence().next().value;\n",
            ),
        ).toStrictEqual([]);
    });
});

/** The reference's `RESCHEDULE`, as a Durable Object re-arming its own alarm. */
const REARM = "await this.ctx.storage.setAlarm(Date.now() + 1000);";

/** `body` as the `alarm()` of a Durable Object, with `args` read the way the reference's handler received them. */
const inAlarm = (body: string): string => `import { DurableObject } from "cloudflare:workers";

export class Room extends DurableObject {
    async alarm() {
        const args = (await this.ctx.storage.get("args")) ?? {};
${body}
    }
}
`;

describe("alarm_always_rearms", () => {
    // The reference's "does not flag" table: an unconditional call. Here: reported.
    it.each([
        ["straight-line code", REARM],
        ["a try block", `try { ${REARM} } catch { return; }`],
        ["a finally block", `try { await this.ctx.storage.get(args.id); } finally { ${REARM} }`],
        ["a do body, which runs at least once", `do { ${REARM} } while (args.more);`],
        ["an if condition", "if (await this.ctx.storage.setAlarm(Date.now() + 1000)) { void 0; }"],
        ["a statement after a batch loop with no exit", `for (const id of args.ids) { await this.ctx.storage.get(id); }\n${REARM}`],
        ["a statement after an if that never exits", `if (args.verbose) console.log("tick");\n${REARM}`],
        ["a statement after a switch that only breaks", `switch (args.state) { case "a": break; }\n${REARM}`],
        ["a returned call", "return await this.ctx.storage.setAlarm(Date.now() + 1000);"],
        ["a call followed by a throw in a nested callback", `${REARM}\nargs.ids.forEach(() => { throw new Error("x"); });`],
        ["a ternary's condition", "(await this.ctx.storage.setAlarm(Date.now() + 1000)) ? 1 : 2;"],
        ["the left operand of &&", "(await this.ctx.storage.setAlarm(Date.now() + 1000)) && args.more;"],
        ["a call preceded only by plain statements", `const now = Date.now();\nvoid now;\n${REARM}`],
    ])("reports a re-arm in %s", (_label, body) => {
        expect.assertions(1);

        expect(names(inAlarm(body))).toStrictEqual(["alarm_always_rearms"]);
    });

    // The reference's "flags" table: a guarded call. Here: not reported.
    it.each([
        ["an if branch", `if (args.more) { ${REARM} }`],
        ["an else branch", `if (args.done) { return; } else { ${REARM} }`],
        ["a loop body", `for (const id of args.ids) { ${REARM} }`],
        ["a catch clause", `try { await this.ctx.storage.get(args.id); } catch { ${REARM} }`],
        ["a switch arm", `switch (args.state) { case "open": ${REARM} }`],
        ["a default arm", `switch (args.state) { default: ${REARM} }`],
        ["the right of &&", "args.more && (await this.ctx.storage.setAlarm(Date.now() + 1000));"],
        ["the right of ??", "args.next ?? (await this.ctx.storage.setAlarm(Date.now() + 1000));"],
        ["the right of ||=", "args.next ||= await this.ctx.storage.setAlarm(Date.now() + 1000);"],
        ["a ternary arm", "args.more ? await this.ctx.storage.setAlarm(Date.now() + 1000) : undefined;"],
        ["an optional call", "await this.ctx.storage?.setAlarm(Date.now() + 1000);"],
        ["an optional link earlier in the chain", "await this.ctx?.storage.setAlarm(Date.now() + 1000);"],
        ["a statement after an early return", `if (args.done) return;\n${REARM}`],
        ["a callback nested in the handler", `args.ids.forEach(async () => { ${REARM} });`],
        ["a statement after a return inside a try", `try { if (!args.id) return; } catch { return; }\n${REARM}`],
        ["a statement after a return inside a switch", `switch (args.state) { case "done": return; }\n${REARM}`],
        ["a statement after a return inside a nested block", `{ if (args.done) return; }\n${REARM}`],
        ["a statement after a labeled block that may return", `check: { if (args.ok) break check; return; }\n${REARM}`],
        ["an argument of an optional call", "args.logger?.info(await this.ctx.storage.setAlarm(Date.now() + 1000));"],
        ["a call whose result is kept", "const pending = await this.ctx.storage.setAlarm(Date.now() + 1000);\nvoid pending;"],
        ["a call a later throw makes the platform retry", `${REARM}\nif (!(await this.ctx.storage.get(args.id))) throw new Error("gone");`],
    ])("does not report a re-arm inside %s", (_label, body) => {
        expect.assertions(1);

        expect(names(inAlarm(body))).toStrictEqual([]);
    });

    it.each([
        ["this.state.storage", "await this.state.storage.setAlarm(Date.now() + 1000);"],
        ["a local ctx", "const ctx = this.ctx;\nawait ctx.storage.setAlarm(Date.now() + 1000);"],
        ["a minified receiver", "await this.c.storage.setAlarm(Date.now() + 1e3);"],
    ])("reports a re-arm through %s", (_label, body) => {
        expect.assertions(1);

        expect(names(inAlarm(body))).toStrictEqual(["alarm_always_rearms"]);
    });

    it("reports it on any class — a bundle does not say which classes are Durable Objects", () => {
        expect.assertions(1);

        expect(names("var Poller = class {\n  async alarm() {\n    await this.ctx.storage.setAlarm(Date.now() + 1e3);\n  }\n};\n")).toStrictEqual([
            "alarm_always_rearms",
        ]);
    });

    it("does not look past `alarm`: other methods, static methods and object literals are not alarm handlers", () => {
        expect.assertions(1);

        expect(
            names(`export class Room {
    async start() { await this.ctx.storage.setAlarm(Date.now()); }
    static async alarm(ctx) { await ctx.storage.setAlarm(Date.now()); }
}
export const handlers = { async alarm() { await this.ctx.storage.setAlarm(Date.now()); } };
`),
        ).toStrictEqual([]);
    });

    it("does not report the build runner's own conditional re-arm (BuildRunnerDO.alarm)", () => {
        expect.assertions(1);

        // `src/builds/runner-do.ts`, as esbuild emits it: re-armed only when a
        // next half exists, after two early returns.
        expect(
            names(`var STATE_KEY = "run";
var BuildRunnerDO = class extends DurableObject {
  async alarm() {
    const state = await this.ctx.storage.get(STATE_KEY);
    if (state === void 0) {
      return;
    }
    const stage = state.started === true ? "interrupted" : state.stage;
    await this.ctx.storage.put(STATE_KEY, { ...state, started: true });
    const result = await this.runStage(state.job, stage);
    if (result.next === null) {
      await this.ctx.storage.delete(STATE_KEY);
      return;
    }
    await this.ctx.storage.put(STATE_KEY, { job: state.job, stage: result.next });
    await this.ctx.storage.setAlarm(Date.now());
  }
};
`),
        ).toStrictEqual([]);
    });
});

/** A release manifest where `SELF` produces to `jobs`, which this Worker also consumes. */
const SELF_FEEDING = {
    bindings: [
        { binding: "SELF", resource: "jobs", type: "queue_producer" },
        { binding: "OTHER", resource: "emails", type: "queue_producer" },
        { binding: "jobs", resource: "jobs", type: "queue_consumer" },
    ],
};

describe("queue_self_resend", () => {
    it.each([
        ["an exported default object's queue()", "export default {\n  async queue(batch, env) {\n    await env.SELF.send({ again: true });\n  }\n};\n"],
        ["a minified handler", "var a={async queue(e,t){await t.SELF.sendBatch(e.messages.map(m=>({body:m.body})))}};export{a as default};\n"],
        [
            "a class queue() through this.env",
            "export class Consumer {\n  async queue(batch) {\n    await this.env.SELF.send(batch.messages[0].body);\n  }\n}\n",
        ],
    ])("reports %s re-sending to its own queue", (_label, code) => {
        expect.assertions(1);

        expect(analyzeSource(code, { manifest: SELF_FEEDING })).toMatchObject([{ binding: "SELF", name: "queue_self_resend", queue: "jobs" }]);
    });

    it.each([
        [
            "a send per message inside a loop",
            "export default { async queue(batch, env) { for (const m of batch.messages) { await env.SELF.send(m.body); } } };",
        ],
        ["a send behind a condition", "export default { async queue(batch, env) { if (batch.messages.length > 1) await env.SELF.send({}); } };"],
        ["a send to another queue", "export default { async queue(batch, env) { await env.OTHER.send({}); } };"],
        ["a destructured env, which the scan cannot follow", "export default { async queue(batch, { SELF }) { await SELF.send({}); } };"],
    ])("does not report %s", (_label, code) => {
        expect.assertions(1);

        expect(names(code, SELF_FEEDING)).toStrictEqual([]);
    });

    it("reports nothing without a manifest saying the producer feeds a consumed queue", () => {
        expect.assertions(2);

        const code = "export default { async queue(batch, env) { await env.SELF.send({}); } };";

        expect(names(code)).toStrictEqual([]);
        expect(names(code, { bindings: [{ binding: "SELF", resource: "jobs", type: "queue_producer" }] })).toStrictEqual([]);
    });
});

describe("the scan budget", () => {
    it("stops with a timeout once the deadline has passed", () => {
        expect.assertions(1);

        expect(() => analyzeSource(inFunction("while (true) {}"), { deadline: 0, now: () => 1 })).toThrow(/time budget/u);
    });

    it("refuses a module it cannot parse with acorn's reason, not the source", () => {
        expect.assertions(1);

        expect(() => analyzeSource("export const = secretToken;")).toThrow(/^the bundle could not be parsed \(Unexpected token \(1:13\)\)$/u);
    });
});
