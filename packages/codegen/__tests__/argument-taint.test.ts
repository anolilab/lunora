import type { CallExpression, Node as TsNode, SourceFile } from "ts-morph";
import { Project, SyntaxKind } from "ts-morph";
import { beforeEach, describe, expect, it } from "vitest";

import {
    enclosingExportName,
    isArgumentDerived,
    isRequestInputDerived,
    isScopedByContext,
    isUnmodifiedArgumentPassthrough,
    referencesArgs,
    referencesRequestInput,
    singleHopInitializer,
} from "../src/argument-taint";
import { calleeName } from "../src/discover/callee";

let project: Project;
let fileCounter: number;

/** The marker call every fixture wraps its node of interest in. */
const findSink = (file: SourceFile): CallExpression => {
    const sink = file.getDescendantsOfKind(SyntaxKind.CallExpression).find((call) => call.getExpression().getText() === "SINK");

    if (sink === undefined) {
        throw new Error("test fixture has no SINK(…) call");
    }

    return sink;
};

/**
 * Build a handler source and hand back the first argument of its `SINK(…)` call —
 * the node a sink feeder would pass to these predicates. `SINK` is just a marker;
 * the predicates are syntactic and never resolve it.
 */
const sinkArgument = (body: string, parameters = "{ ctx, args }"): TsNode => {
    fileCounter += 1;

    const file = project.createSourceFile(`taint-${fileCounter.toString()}.ts`, `export const handler = mutation(async (${parameters}) => {\n${body}\n});\n`, {
        overwrite: true,
    });

    const [argument] = findSink(file).getArguments();

    if (argument === undefined) {
        throw new Error("test fixture's SINK(…) call has no argument");
    }

    return argument;
};

/** The callee node of the first non-`SINK` call in `body` — what {@link calleeName} is fed. */
const calleeOf = (body: string): TsNode => sinkArgument(body).asKindOrThrow(SyntaxKind.CallExpression).getExpression();

describe("argument-taint", () => {
    beforeEach(() => {
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
        fileCounter = 0;
    });

    describe("calleeName", () => {
        it("reads a bare identifier and the trailing member name, and gives up on anything else", () => {
            expect.assertions(3);

            expect(calleeName(calleeOf(`SINK(createPayment({}));`))).toBe("createPayment");
            // Import-agnostic on purpose: a re-export or namespace alias still resolves.
            expect(calleeName(calleeOf(`SINK(payment.createPayment({}));`))).toBe("createPayment");
            expect(calleeName(calleeOf(`SINK(handlers["createPayment"]({}));`))).toBeUndefined();
        });
    });

    describe("referencesArgs", () => {
        it("counts value references only, not same-named property positions", () => {
            expect.assertions(4);

            expect(referencesArgs(sinkArgument(`SINK(args.url);`))).toBe(true);
            // A `{ args }` shorthand IS a value reference; `{ args: 1 }`'s key and
            // `payload.args`'s member name are different `args` and carry no taint.
            expect(referencesArgs(sinkArgument(`SINK({ args });`))).toBe(true);
            expect(referencesArgs(sinkArgument(`SINK({ args: 1 });`))).toBe(false);
            expect(referencesArgs(sinkArgument(`SINK(payload.args);`))).toBe(false);
        });
    });

    describe("singleHopInitializer", () => {
        it("resolves the nearest PRECEDING same-named const in the same function", () => {
            expect.assertions(3);

            expect(singleHopInitializer(sinkArgument(`const key = args.key;\nSINK(key);`))?.getText()).toBe("args.key");
            // A declaration that FOLLOWS the use cannot be its source.
            expect(singleHopInitializer(sinkArgument(`SINK(key);\nconst key = args.key;`))).toBeUndefined();
            // Only identifiers hop; a member access is already its own root.
            expect(singleHopInitializer(sinkArgument(`SINK(args.key);`))).toBeUndefined();
        });
    });

    describe("isArgumentDerived", () => {
        it("is direct-or-single-hop: one hop counts, two do not", () => {
            expect.assertions(4);

            expect(isArgumentDerived(sinkArgument(`SINK(args.key);`))).toBe(true);
            expect(isArgumentDerived(sinkArgument(`const key = args.key;\nSINK(key);`))).toBe(true);
            // Two hops is the documented boundary — a deliberate fail-safe
            // under-report rather than an unbounded dataflow walk.
            expect(isArgumentDerived(sinkArgument(`const first = args.key;\nconst second = first;\nSINK(second);`))).toBe(false);
            expect(isArgumentDerived(sinkArgument(`const key = "static";\nSINK(key);`))).toBe(false);
        });

        it("stays fail-open through a helper call embedding args", () => {
            expect.assertions(2);

            expect(isArgumentDerived(sinkArgument(`SINK(hash(args.key));`))).toBe(true);
            expect(isArgumentDerived(sinkArgument(`SINK(new URL(args.url));`))).toBe(true);
        });
    });

    describe("unmodified-argument passthrough", () => {
        it("rejects a value a call could have recomputed, and keeps plain forwarding", () => {
            expect.assertions(4);

            expect(isUnmodifiedArgumentPassthrough(sinkArgument(`SINK(args.key);`))).toBe(true);
            expect(isUnmodifiedArgumentPassthrough(sinkArgument(`SINK(\`\${args.key}.png\`);`))).toBe(true);
            // The content-addressed-key case: it textually references `args`, but the
            // call in between recomputed it from data the server already trusts.
            expect(isUnmodifiedArgumentPassthrough(sinkArgument(`SINK(storeFile(args.bytes));`))).toBe(false);
            expect(isUnmodifiedArgumentPassthrough(sinkArgument(`const key = storeFile(args.bytes);\nSINK(key);`))).toBe(false);
        });
    });

    describe("isScopedByContext", () => {
        it("is symmetric with isArgumentDerived, so a ctx-scoped key wins over its args half", () => {
            expect.assertions(6);

            const direct = sinkArgument(`SINK(\`\${ctx.auth.userId}/\${args.name}\`);`);

            // Both predicates fire on the same node — that is the point. The IDOR
            // sinks read `isScopedByContext` as the suppressor, so a correctly
            // prefixed key is not flagged despite being argument-derived.
            expect(isScopedByContext(direct)).toBe(true);
            expect(isArgumentDerived(direct)).toBe(true);

            // The recommended remediation puts ctx TWO hops away: one hop expands the
            // key to its template, and the identity reaches ctx only via `userId`.
            // A regression here disagrees with `isArgumentDerived` and flags the very
            // shape the docs tell users to write.
            const viaLocal = sinkArgument(`const userId = ctx.auth.userId;\nconst key = \`\${userId}/\${args.name}\`;\nSINK(key);`);

            expect(isScopedByContext(viaLocal)).toBe(true);
            expect(isArgumentDerived(viaLocal)).toBe(true);

            const unscoped = sinkArgument(`const key = \`uploads/\${args.name}\`;\nSINK(key);`);

            expect(isScopedByContext(unscoped)).toBe(false);
            expect(isArgumentDerived(unscoped)).toBe(true);
        });
    });

    describe("request-rooted taint", () => {
        it("follows the freely-named request parameter directly and one hop", () => {
            expect.assertions(4);

            const direct = sinkArgument(`SINK(request.headers.get("x-tag"));`, "request");

            expect(referencesRequestInput(direct, "request")).toBe(true);
            // The parameter name is the handler's to choose — `req`/`r` must work too.
            expect(referencesRequestInput(sinkArgument(`SINK(new URL(r.url).searchParams.get("q"));`, "r"), "r")).toBe(true);

            expect(isRequestInputDerived(sinkArgument(`const headers = request.headers;\nSINK(headers);`, "request"), "request")).toBe(true);
            expect(isRequestInputDerived(sinkArgument(`SINK(env.DEFAULT_TAG);`, "request"), "request")).toBe(false);
        });

        it("hops through the ROOT of a member access, which the bare-identifier hop cannot reach", () => {
            expect.assertions(2);

            // A reflected body value is always bound to a `const` before its fields
            // are read, so `body.tag` only reaches the request through `body`.
            const bodyField = sinkArgument(`const body = await request.json();\nSINK(body.tag);`, "request");

            expect(isRequestInputDerived(bodyField, "request")).toBe(true);
            expect(referencesRequestInput(bodyField, "request")).toBe(false);
        });
    });

    describe("enclosingExportName", () => {
        it("attributes a sink to the exported declaration, walking past local bindings", () => {
            expect.assertions(2);

            expect(enclosingExportName(sinkArgument(`const result = SINK(args.key);`))).toBe("handler");

            const inline = project.createSourceFile("inline.ts", `router.route("/x", async () => { SINK(1); });\n`, { overwrite: true });

            expect(enclosingExportName(findSink(inline))).toBe("<module>");
        });
    });
});
