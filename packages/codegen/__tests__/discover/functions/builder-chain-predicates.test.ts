/**
 * The two builder-chain predicates every protection feeder walks with.
 *
 * Both fail **silently**: a false negative makes the lint that depends on them
 * simply not fire, so nothing errors and nothing is reported — the exact shape
 * of bug that reaches production green. `chainUsesWrappedCall` in particular
 * gates the `mask(...)` / `rls(...)` detection, so a miss reads as "this
 * procedure declares no row policy" rather than as a failure.
 */
import { Node, Project, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import chainHasStep from "../../../src/discover/functions/chain-has-step";
import chainUsesWrappedCall from "../../../src/discover/functions/chain-uses-wrapped-call";

/**
 * The receiver of the terminal call in `expression` — i.e. what a caller holds
 * after `classifyProcedureCall` hands back `receiver`. For `c.use(x).query(h)`
 * that is `c.use(x)`.
 *
 * Each call gets its own in-memory project so nothing has to coordinate file
 * names or reset shared state between assertions. `preamble` exists so a case
 * can declare imports: without it this helper could not express an aliased
 * import at all, which is exactly why the drift between `chainUsesWrappedCall`
 * and `rlsCallsInChain` went untested.
 */
const terminalReceiver = (expression: string, preamble = ""): Node => {
    const call = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true })
        .createSourceFile("case.ts", `${preamble}\nconst value = ${expression};`)
        .getFirstDescendantByKindOrThrow(SyntaxKind.CallExpression);
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee)) {
        throw new TypeError(`not a terminal call: ${expression}`);
    }

    return callee.getExpression();
};

describe("chainHasStep", () => {
    it("finds a step at the end of the chain and one buried several steps deep", () => {
        expect.assertions(2);

        expect(chainHasStep(terminalReceiver("c.output(v).query(h)"), "output")).toBe(true);
        expect(chainHasStep(terminalReceiver("c.output(v).input(a).use(m).query(h)"), "output")).toBe(true);
    });

    it("returns false for a method the chain never carries", () => {
        expect.assertions(1);

        expect(chainHasStep(terminalReceiver("c.input(a).use(m).query(h)"), "output")).toBe(false);
    });

    it("walks through the wrappers a chain can be dressed in", () => {
        expect.assertions(2);

        expect(chainHasStep(terminalReceiver("(c.output(v) as B).query(h)"), "output")).toBe(true);
        expect(chainHasStep(terminalReceiver("((c.output(v) as B).input(a)).query(h)"), "output")).toBe(true);
    });

    it("stops at a non-property-access callee instead of walking past it", () => {
        expect.assertions(1);

        // `getBuilder()` is a CallExpression whose callee is a bare identifier,
        // so the walk breaks there. Without the break this would descend into
        // the argument list and could match an unrelated `.output(...)`.
        expect(chainHasStep(terminalReceiver("getBuilder(base.output(v)).query(h)"), "output")).toBe(false);
    });
});

describe("chainUsesWrappedCall", () => {
    it("matches the wrapped call at the end of the chain and deep inside it", () => {
        expect.assertions(2);

        expect(chainUsesWrappedCall(terminalReceiver("c.use(rls(policies)).query(h)"), "use", "rls")).toBe(true);
        expect(chainUsesWrappedCall(terminalReceiver("c.use(rls(p)).input(a).use(rateLimit(o)).query(h)"), "use", "rls")).toBe(true);
    });

    it("matches a method-call wrapper by its member name, not its receiver", () => {
        expect.assertions(1);

        // A property-access callee is matched on its member name, so
        // `guards.rls(p)` is a `rls` call for this purpose.
        expect(chainUsesWrappedCall(terminalReceiver("c.use(guards.rls(p)).query(h)"), "use", "rls")).toBe(true);
    });

    it("rejects a bare reference passed where a call is required", () => {
        expect.assertions(1);

        // `.use(rls)` hands over the factory itself, never invoking it — no
        // policy is declared, so treating it as one would suppress a real lint.
        expect(chainUsesWrappedCall(terminalReceiver("c.use(rls).query(h)"), "use", "rls")).toBe(false);
    });

    it("rejects a different wrapped callee and a different step method", () => {
        expect.assertions(2);

        expect(chainUsesWrappedCall(terminalReceiver("c.use(mask(columns)).query(h)"), "use", "rls")).toBe(false);
        expect(chainUsesWrappedCall(terminalReceiver("c.input(rls(p)).query(h)"), "use", "rls")).toBe(false);
    });

    it("resolves an aliased import, agreeing with rlsCallsInChain and maskCallsInChain", () => {
        expect.assertions(2);

        // These three answer the same question about the same chain and had
        // drifted: the other two resolved an alias and this one compared callee
        // text, so `import { rls as rowLevel }` read as protected to
        // `discoverRlsProcedures` and unprotected to the feeders built on this
        // one (`normalize-id-authorization`, `raw-row-returns`). They share the
        // walk now, so the answers cannot diverge again.
        expect(chainUsesWrappedCall(terminalReceiver(`c.use(rowLevel(p)).query(h)`, `import { rls as rowLevel } from "@lunora/server";`), "use", "rls")).toBe(
            true,
        );

        // No import to resolve — nothing ties the name to `rls`.
        expect(chainUsesWrappedCall(terminalReceiver(`c.use(rowLevel(p)).query(h)`), "use", "rls")).toBe(false);
    });

    it("walks through the wrappers a chain can be dressed in", () => {
        expect.assertions(2);

        expect(chainUsesWrappedCall(terminalReceiver(`(c.use(rls(p)) as B).query(h)`), "use", "rls")).toBe(true);
        expect(chainUsesWrappedCall(terminalReceiver(`((c.input(a) as B).use(rls(p))).query(h)`), "use", "rls")).toBe(true);
    });

    it("only inspects the first argument of a step", () => {
        expect.assertions(1);

        // The predicate documents arg[0]; a wrapper in a later position is not
        // the declared shape and must not match.
        expect(chainUsesWrappedCall(terminalReceiver("c.use(logger, rls(p)).query(h)"), "use", "rls")).toBe(false);
    });
});
