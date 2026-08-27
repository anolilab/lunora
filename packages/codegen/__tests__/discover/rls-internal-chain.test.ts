/**
 * The chain walk behind every RLS finding.
 *
 * `rlsCallsInChain` is the single decision "does this procedure declare
 * row-level-security policies?" — the lint's `rlsFromBuilderChain`, the studio
 * inspector's `rlsMetadataFromChain`, and (through `usesRls`) the
 * `privileged_dispatch_unvalidated_payload` finding all read it. A miss is
 * silent in every direction: no error, no diagnostic, just a policy the
 * advisors never knew existed. So the accept/reject boundary is pinned here
 * directly rather than through whichever top-level discovery happens to hit it.
 */
import type { Node as TsNode } from "ts-morph";
import { Project, SyntaxKind } from "ts-morph";
import { beforeEach, describe, expect, it } from "vitest";

import { isRlsCall, rlsCallsInChain } from "../../src/discover/rls-procedures/internal-chain";

let project: Project;

/** The node for a standalone expression, for feeding {@link isRlsCall} directly. */
const expressionOf = (text: string, preamble = ""): TsNode => {
    const source = project.createSourceFile("expression.ts", `${preamble}\nconst value = ${text};`, { overwrite: true });

    return source.getVariableDeclarationOrThrow("value").getInitializerOrThrow();
};

/**
 * The builder receiver of `chain` — the expression left of the terminal
 * `.query(...)` / `.mutation(...)` call, which is exactly the node
 * `classifyProcedureCall` hands to `rlsCallsInChain`.
 */
const receiverOf = (chain: string): TsNode =>
    expressionOf(chain).asKindOrThrow(SyntaxKind.CallExpression).getExpressionIfKindOrThrow(SyntaxKind.PropertyAccessExpression).getExpression();

describe("rls internal chain", () => {
    beforeEach(() => {
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    });

    describe("isRlsCall", () => {
        it("accepts an invoked `rls`, including through type arguments", () => {
            expect.assertions(2);

            expect(isRlsCall(expressionOf(`rls([{ table: "documents", on: "read", when: () => true }])`))).toBe(true);
            expect(isRlsCall(expressionOf(`rls<Doc>(policies)`))).toBe(true);
        });

        it("accepts a property-access callee named `rls` regardless of what it hangs off", () => {
            expect.assertions(2);

            // Matched by name, not by import origin — so a namespace import works…
            expect(isRlsCall(expressionOf(`rlsModule.rls(policies)`))).toBe(true);
            // …and so does a same-named method on an unrelated object (a known
            // false positive the name-based match trades for robustness).
            expect(isRlsCall(expressionOf(`database.rls(policies)`))).toBe(true);
        });

        it("rejects a bare `rls` reference that is never called", () => {
            expect.assertions(2);

            // `.use(rls)` passes the factory itself, not a policy set.
            expect(isRlsCall(expressionOf(`rls`))).toBe(false);
            expect(isRlsCall(expressionOf(`rlsModule.rls`))).toBe(false);
        });

        it("rejects callee shapes that are not a plain identifier or property access", () => {
            expect.assertions(3);

            expect(isRlsCall(expressionOf(`new rls(policies)`))).toBe(false);
            expect(isRlsCall(expressionOf(`rlsModule["rls"](policies)`))).toBe(false);
            expect(isRlsCall(expressionOf(`makeRls()(policies)`))).toBe(false);
        });

        it("rejects names that merely contain `rls`", () => {
            expect.assertions(2);

            expect(isRlsCall(expressionOf(`withRls(policies)`))).toBe(false);
            expect(isRlsCall(expressionOf(`rlsGuard(policies)`))).toBe(false);
        });

        it("resolves an aliased `rls` import back to its exported name", () => {
            expect.assertions(2);

            // The textual match alone read a renamed import as unrelated
            // middleware, leaving the procedure unprotected to every RLS advisor
            // — while `classifyProcedureCall`, which does resolve aliases,
            // classified the very same declaration correctly.
            expect(isRlsCall(expressionOf(`rowLevel(policies)`, `import { rls as rowLevel } from "@lunora/server";`))).toBe(true);

            // Without an import there is nothing tying the name to `rls`.
            expect(isRlsCall(expressionOf(`rowLevel(policies)`, ``))).toBe(false);
        });
    });

    describe("rlsCallsInChain", () => {
        it("finds `.use(rls(...))` sitting directly on the builder root", () => {
            expect.assertions(2);

            const calls = rlsCallsInChain(receiverOf(`c.query.use(rls(policies)).query(handler)`));

            expect(calls).toHaveLength(1);
            expect(calls[0]?.getArguments()[0]?.getText()).toBe("policies");
        });

        it("finds it several steps deep behind other builder methods", () => {
            expect.assertions(2);

            const calls = rlsCallsInChain(receiverOf(`c.query.use(rls(policies)).input(args).use(audit).output(shape).mutation(handler)`));

            expect(calls).toHaveLength(1);
            expect(calls[0]?.getText()).toBe("rls(policies)");
        });

        it("collects every `.use(rls(...))` in one chain, outermost step first", () => {
            expect.assertions(1);

            // The walk runs leftward, so the returned order is the reverse of
            // source order — the flatMap in `rlsFromBuilderChain` inherits it.
            const calls = rlsCallsInChain(receiverOf(`c.query.use(rls(readPolicies)).use(audit).use(rls(writePolicies)).query(handler)`));

            expect(calls.map((call) => call.getText())).toStrictEqual(["rls(writePolicies)", "rls(readPolicies)"]);
        });

        it("returns nothing for a chain with no rls step", () => {
            expect.assertions(3);

            expect(rlsCallsInChain(receiverOf(`c.query.input(args).use(auth).query(handler)`))).toStrictEqual([]);
            // The factory passed uncalled is not a policy declaration.
            expect(rlsCallsInChain(receiverOf(`c.query.use(rls).query(handler)`))).toStrictEqual([]);
            expect(rlsCallsInChain(receiverOf(`c.query.use().query(handler)`))).toStrictEqual([]);
        });

        it("ignores an rls call that is not the first argument of a `use` step", () => {
            expect.assertions(3);

            expect(rlsCallsInChain(receiverOf(`c.query.middleware(rls(policies)).query(handler)`))).toStrictEqual([]);
            expect(rlsCallsInChain(receiverOf(`c.query.use(audit, rls(policies)).query(handler)`))).toStrictEqual([]);
            expect(rlsCallsInChain(receiverOf(`c.query.use(...middlewares).query(handler)`))).toStrictEqual([]);
        });

        it("returns nothing when the receiver is not a call expression", () => {
            expect.assertions(1);

            expect(rlsCallsInChain(receiverOf(`builder.query(handler)`))).toStrictEqual([]);
        });

        it("walks through the wrappers a chain can be dressed in", () => {
            expect.assertions(3);

            // A parenthesised or cast chain was a real false negative: the
            // policies are declared and no advisor saw them. None of these
            // wrappers change what the expression evaluates to.
            expect(rlsCallsInChain(receiverOf(`(c.query.use(rls(policies))).query(handler)`))).toHaveLength(1);
            expect(rlsCallsInChain(receiverOf(`(c.query.use(rls(policies)) as Builder).query(handler)`))).toHaveLength(1);
            // Wrapped part-way along, rather than around the whole chain.
            expect(rlsCallsInChain(receiverOf(`((c.query.input(a) as Builder).use(rls(policies))).query(handler)`))).toHaveLength(1);
        });

        it("stops walking at a step whose callee is not a property access", () => {
            expect.assertions(1);

            // `c.query.use(rls(inner))(extra)` is a call on a call, so the walk
            // breaks there and never reaches the inner rls step.
            const calls = rlsCallsInChain(receiverOf(`c.query.use(rls(inner))(extra).use(rls(outer)).query(handler)`));

            expect(calls.map((call) => call.getText())).toStrictEqual(["rls(outer)"]);
        });

        it("hands back the rls call itself so callers can read its arguments", () => {
            expect.assertions(2);

            const calls = rlsCallsInChain(receiverOf(`c.query.use(rls([{ table: "documents" }], { roles: [admin] })).query(handler)`));

            expect(calls[0]?.getArguments()[0]?.getText()).toBe(`[{ table: "documents" }]`);
            expect(calls[0]?.getArguments()[1]?.getText()).toBe("{ roles: [admin] }");
        });
    });
});
