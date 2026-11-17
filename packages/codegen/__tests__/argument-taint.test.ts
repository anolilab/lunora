import type { CallExpression, Node as TsNode, SourceFile } from "ts-morph";
import { Project, SyntaxKind } from "ts-morph";
import { beforeEach, describe, expect, it } from "vitest";

import {
    isArgumentDerived,
    isRequestInputDerived,
    isScopedByContext,
    isScopedByIdentity,
    isUnmodifiedArgumentPassthrough,
    referencesArgs,
    referencesRequestInput,
    singleHopInitializer,
} from "../src/argument-taint";
import { callSiteScopeOf } from "../src/discover/attribution";
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

        it("follows a destructured `args` parameter — the spelling every handler here is written in", () => {
            expect.assertions(5);

            expect(referencesArgs(sinkArgument(`SINK(url);`, "{ args: { url }, ctx }"))).toBe(true);
            // Renamed, and nested one level deeper.
            expect(referencesArgs(sinkArgument(`SINK(target);`, "{ args: { url: target }, ctx }"))).toBe(true);
            expect(referencesArgs(sinkArgument(`SINK(id);`, "{ args: { page: { id } }, ctx }"))).toBe(true);
            // A rest element holds what is left of the SAME object, so it is
            // tainted too — no special case, the chain walk reaches `args` anyway.
            expect(referencesArgs(sinkArgument(`SINK(rest);`, "{ args: { url, ...rest }, ctx }"))).toBe(true);
            // A sibling binding off a different property is not `args`.
            expect(referencesArgs(sinkArgument(`SINK(userId);`, "{ args, ctx: { userId } }"))).toBe(false);
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

        it("skips a same-named binding in a sibling block, which the use cannot see", () => {
            expect.assertions(2);

            const source = `const url = args.url;\nif (flag) {\n    const { url } = trustedConfig;\n}\nSINK(url);`;

            expect(singleHopInitializer(sinkArgument(source))?.getText()).toBe("args.url");
            expect(isArgumentDerived(sinkArgument(source))).toBe(true);
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

        it("sees an args-derived default on a destructured binding", () => {
            expect.assertions(3);

            expect(isArgumentDerived(sinkArgument(`const { network: { url } = args.network } = config;\nSINK(url);`))).toBe(true);

            expect(isArgumentDerived(sinkArgument(`const { url = args.url } = config;\nSINK(url);`))).toBe(true);
            expect(isArgumentDerived(sinkArgument(`const { url = "https://fixed.example" } = config;\nSINK(url);`))).toBe(false);
        });

        it("stays fail-open through a helper call embedding args", () => {
            expect.assertions(2);

            expect(isArgumentDerived(sinkArgument(`SINK(hash(args.key));`))).toBe(true);
            expect(isArgumentDerived(sinkArgument(`SINK(new URL(args.url));`))).toBe(true);
        });

        it("follows a binding destructured from args at the body level, renames and nesting included", () => {
            expect.assertions(3);

            expect(isArgumentDerived(sinkArgument(`const { url } = args;\nSINK(url);`))).toBe(true);
            expect(isArgumentDerived(sinkArgument(`const { target: url } = args;\nSINK(url);`))).toBe(true);
            expect(isArgumentDerived(sinkArgument(`const { page: { id } } = args;\nSINK(id);`))).toBe(true);
        });

        it("follows a local composed into a larger expression, one hop per identifier", () => {
            expect.assertions(2);

            expect(isArgumentDerived(sinkArgument(`const host = args.host;\nSINK(\`https://\${host}/x\`);`))).toBe(true);
            expect(isArgumentDerived(sinkArgument(`const body = args.payload;\nSINK(body.url);`))).toBe(true);
        });

        it("does not follow a destructure from a non-args source, or a second hop through a composed local", () => {
            expect.assertions(4);

            expect(isArgumentDerived(sinkArgument(`const { userId } = ctx.auth;\nSINK(\`users/\${userId}\`);`))).toBe(false);
            expect(isArgumentDerived(sinkArgument(`const host = "example.com";\nSINK(\`https://\${host}/x\`);`))).toBe(false);
            expect(isArgumentDerived(sinkArgument(`const first = args.key;\nconst second = first;\nSINK(\`k/\${second}\`);`))).toBe(false);
            expect(isArgumentDerived(sinkArgument(`const { url } = config;\nSINK(url);`))).toBe(false);
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

        it("rejects a composed key whose only args-derived part a call recomputed, and keeps one that forwards an arg", () => {
            expect.assertions(8);

            expect(isUnmodifiedArgumentPassthrough(sinkArgument(`const digest = sha256Hex(args.bytes);\nSINK(\`blobs/\${digest}\`);`))).toBe(false);
            expect(isUnmodifiedArgumentPassthrough(sinkArgument(`const digest = await sha256Hex(args.bytes);\nSINK(\`blobs/\${digest}\`);`))).toBe(false);
            expect(isUnmodifiedArgumentPassthrough(sinkArgument(`const key = await storeFile(args.bytes);\nSINK(key);`))).toBe(false);
            expect(isUnmodifiedArgumentPassthrough(sinkArgument(`const name = args.name;\nSINK(\`blobs/\${name}\`);`))).toBe(true);
            expect(isUnmodifiedArgumentPassthrough(sinkArgument(`const name = args.name;\nSINK(\`blobs/\${sha256Hex(name)}\`);`))).toBe(false);
            expect(isUnmodifiedArgumentPassthrough(sinkArgument(`const { key = args.key } = config;\nSINK(key);`))).toBe(true);
            expect(isUnmodifiedArgumentPassthrough(sinkArgument(`const { key = args.key } = config;\nSINK(\`prefix/\${key}\`);`))).toBe(true);
            expect(isUnmodifiedArgumentPassthrough(sinkArgument(`const digest = sha256Hex(args.bytes);\nSINK(\`blobs/\${digest}/\${args.name}\`);`))).toBe(
                true,
            );
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

        it("stays symmetric when the handler destructures both halves of its parameter", () => {
            expect.assertions(2);

            const scoped = sinkArgument(`SINK(\`\${userId}/\${name}\`);`, "{ args: { name }, ctx: { auth: { userId } } }");

            expect(isScopedByContext(scoped)).toBe(true);
            expect(isArgumentDerived(scoped)).toBe(true);
        });
    });

    describe("isScopedByIdentity", () => {
        it("accepts a key composed with the caller's own ctx.auth identity, direct or through a local", () => {
            expect.assertions(4);

            expect(isScopedByIdentity(sinkArgument(`SINK(\`\${ctx.auth.userId}/\${args.k}\`);`))).toBe(true);
            expect(isScopedByIdentity(sinkArgument(`const uid = ctx.auth.userId;\nSINK(\`\${uid}/\${args.k}\`);`))).toBe(true);
            expect(isScopedByIdentity(sinkArgument(`const { userId } = ctx.auth;\nSINK(\`\${userId}:\${args.k}\`);`))).toBe(true);
            expect(isScopedByIdentity(sinkArgument(`const me = await ctx.db.users.get(ctx.auth.userId);\nSINK(\`\${me._id}/\${args.k}\`);`))).toBe(true);
        });

        it("accepts a key read off a database row fetched by the caller's identity", () => {
            expect.assertions(7);

            const owned = `const row = await ctx.db.files.findFirst({ where: { ownerId: ctx.auth.userId } });\n`;

            // As a prefix, only a column that names the caller: the row's id, or the one the read matched on.
            expect(isScopedByIdentity(sinkArgument(`${owned}SINK(\`\${row.ownerId}/\${args.k}\`);`))).toBe(true);
            expect(isScopedByIdentity(sinkArgument(`${owned}SINK(\`\${row._id}/\${args.k}\`);`))).toBe(true);
            expect(
                isScopedByIdentity(
                    sinkArgument(`const row = await ctx.db.files.findFirst({ where: { "ownerId": ctx.auth.userId } });\nSINK(\`\${row.ownerId}/\${args.k}\`);`),
                ),
            ).toBe(true);
            expect(
                isScopedByIdentity(
                    sinkArgument(
                        `const { "ownerId": owner } = await ctx.db.files.findFirst({ where: { ownerId: ctx.auth.userId } });\nSINK(\`\${owner}/\${args.k}\`);`,
                    ),
                ),
            ).toBe(true);
            // As the whole key, any column of the caller's own row: a stored reference the caller cannot repoint.
            expect(isScopedByIdentity(sinkArgument(`${owned}SINK(row.storageKey);`))).toBe(true);
            expect(
                isScopedByIdentity(
                    sinkArgument(`const { storageKey } = await ctx.db.files.findFirst({ where: { ownerId: ctx.auth.userId } });\nSINK(storageKey);`),
                ),
            ).toBe(true);
            expect(
                isScopedByIdentity(
                    sinkArgument(`const uid = ctx.auth.userId;\nconst row = await ctx.db.files.findFirst({ where: { ownerId: uid } });\nSINK(row.key);`),
                ),
            ).toBe(true);
        });

        it("reads an identity column through a type assertion on the row", () => {
            expect.assertions(2);

            const read = `ctx.db.files.findFirst({ where: { ownerId: ctx.auth.userId } })`;

            expect(isScopedByIdentity(sinkArgument(`SINK(\`\${(await ${read} as File)._id}/\${args.k}\`);`))).toBe(true);
            expect(isScopedByIdentity(sinkArgument(`SINK(\`\${((await ${read}) satisfies File).ownerId}/\${args.k}\`);`))).toBe(true);
        });

        it("rejects a caller fallback behind a prefix that can drop the identity", () => {
            expect.assertions(11);

            // Nested compositions are flattened before ordering, so a caller part ahead of the identity counts.
            expect(isScopedByIdentity(sinkArgument(`SINK(\`\${\`\${args.tenant}/\${ctx.auth.userId}\`}/\${args.key ?? args.other}\`);`))).toBe(false);
            expect(isScopedByIdentity(sinkArgument(`SINK(\`\${args.tenant}/\${\`\${ctx.auth.userId}/\${args.key ?? args.other}\`}\`);`))).toBe(false);
            // A local bound to a lossy call is no more the identity than the call written inline.
            expect(isScopedByIdentity(sinkArgument(`const uid = ctx.auth.userId.slice(0, 0);\nSINK(\`\${uid}/\${args.key ?? args.other}\`);`))).toBe(false);

            expect(isScopedByIdentity(sinkArgument(`SINK(\`\${ctx.auth.userId[0]}/\${args.key ?? args.other}\`);`))).toBe(false);
            expect(isScopedByIdentity(sinkArgument(`SINK(\`\${String(ctx.auth.userId.length)}/\${args.key ?? args.other}\`);`))).toBe(false);
            expect(isScopedByIdentity(sinkArgument(`SINK(\`\${ctx.auth.userId.length}/\${args.key ?? args.other}\`);`))).toBe(false);
            expect(isScopedByIdentity(sinkArgument(`const uid = ctx.auth.userId;\nSINK(\`\${uid!.length}/\${args.key ?? args.other}\`);`))).toBe(false);
            expect(
                isScopedByIdentity(
                    sinkArgument(
                        `const row = await ctx.db.files.findFirst({ where: { ownerId: ctx.auth.userId } });\nSINK(\`\${row._id.length}/\${args.key ?? args.other}\`);`,
                    ),
                ),
            ).toBe(false);

            expect(isScopedByIdentity(sinkArgument(`SINK(\`\${ctx.auth.userId.slice(0, 0)}/\${args.key ?? args.other}\`);`))).toBe(false);
            expect(isScopedByIdentity(sinkArgument(`SINK(ctx.auth.userId.slice(0, 0) + "/" + (args.key ?? args.other));`))).toBe(false);

            expect(isScopedByIdentity(sinkArgument(`SINK(\`\${ctx.auth.userId && "shared"}/\${args.key ?? args.other}\`);`))).toBe(false);
        });

        it("follows a where filter held in a local and an AND branch to the owner column", () => {
            expect.assertions(5);

            expect(
                isScopedByIdentity(
                    sinkArgument(
                        `const filter = { ownerId: ctx.auth.userId };\nconst row = await ctx.db.files.findFirst({ where: (filter as Filter) });\nSINK(\`\${row.ownerId}/\${args.key ?? args.other}\`);`,
                    ),
                ),
            ).toBe(true);

            const sink = `SINK(\`\${row.ownerId}/\${args.key ?? args.other}\`);`;

            expect(
                isScopedByIdentity(
                    sinkArgument(`const filter = { ownerId: ctx.auth.userId };\nconst row = await ctx.db.files.findFirst({ where: filter });\n${sink}`),
                ),
            ).toBe(true);
            expect(
                isScopedByIdentity(sinkArgument(`const where = { ownerId: ctx.auth.userId };\nconst row = await ctx.db.files.findFirst({ where });\n${sink}`)),
            ).toBe(true);
            expect(
                isScopedByIdentity(
                    sinkArgument(
                        `const row = await ctx.db.files.findFirst({ where: { AND: [{ ownerId: ctx.auth.userId }, { status: "active" }] } });\n${sink}`,
                    ),
                ),
            ).toBe(true);
            // A local that is reassigned may no longer hold the caller's filter.
            expect(
                isScopedByIdentity(
                    sinkArgument(
                        `let filter = { ownerId: ctx.auth.userId };\nfilter = { ownerId: args.owner };\nconst row = await ctx.db.files.findFirst({ where: filter });\n${sink}`,
                    ),
                ),
            ).toBe(false);
        });

        it("refuses a prefix that is not the caller id itself, asserted or not", () => {
            expect.assertions(5);

            expect(
                isScopedByIdentity(
                    sinkArgument(
                        `const { ...id } = await ctx.db.files.findFirst({ where: { ownerId: ctx.auth.userId } });\nSINK(\`\${id}/\${args.key ?? args.other}\`);`,
                    ),
                ),
            ).toBe(false);

            expect(isScopedByIdentity(sinkArgument(`SINK(\`\${ctx.auth.getIdentity}/\${args.key ?? args.other}\`);`))).toBe(false);
            expect(isScopedByIdentity(sinkArgument(`const { getIdentity } = ctx.auth;\nSINK(\`\${getIdentity}/\${args.key ?? args.other}\`);`))).toBe(false);

            expect(isScopedByIdentity(sinkArgument(`SINK(\`\${(ctx.auth.userId as string)[0]}/\${args.key ?? args.other}\`);`))).toBe(false);
            expect(
                isScopedByIdentity(
                    sinkArgument(
                        `const row = await ctx.db.files.findFirst({ where: { ownerId: ctx.auth.userId } });\nSINK(\`\${(row._id as string).length}/\${args.key ?? args.other}\`);`,
                    ),
                ),
            ).toBe(false);
        });

        it("refuses an owner predicate that a spread, a field write or a negation can undo", () => {
            expect.assertions(19);

            const sink = `SINK(\`\${row.ownerId}/\${args.key ?? args.other}\`);`;
            const owned = `const row = await ctx.db.files.findFirst({ where: { ownerId: ctx.auth.userId } });\n`;

            // A comma expression evaluates to its last operand.
            expect(
                isScopedByIdentity(sinkArgument(`const row = await ctx.db.files.findFirst({ where: { ownerId: (ctx.auth.userId, args.ownerId) } });\n${sink}`)),
            ).toBe(false);
            // A spread in the query object can replace the whole `where`.
            expect(
                isScopedByIdentity(sinkArgument(`const row = await ctx.db.files.findFirst({ where: { ownerId: ctx.auth.userId }, ...args.query });\n${sink}`)),
            ).toBe(false);
            // A filter aliased into another object can be written through the alias.
            expect(
                isScopedByIdentity(
                    sinkArgument(
                        `const where = { ownerId: ctx.auth.userId };\nconst holder = { value: where };\nholder.value.ownerId = args.ownerId;\nconst row = await ctx.db.files.findFirst({ where });\n${sink}`,
                    ),
                ),
            ).toBe(false);
            // A field written on the row after the read replaces what the key emits, however the write is spelled.
            expect(isScopedByIdentity(sinkArgument(`${owned}row.ownerId = args.ownerId;\n${sink}`))).toBe(false);
            expect(isScopedByIdentity(sinkArgument(`${owned}({ owner: row.ownerId } = args);\n${sink}`))).toBe(false);
            expect(isScopedByIdentity(sinkArgument(`${owned}[row.ownerId] = args.owners;\n${sink}`))).toBe(false);
            expect(isScopedByIdentity(sinkArgument(`${owned}for (row.ownerId of args.owners) {}\n${sink}`))).toBe(false);
            expect(isScopedByIdentity(sinkArgument(`${owned}for (row.ownerId in args.owners) {}\n${sink}`))).toBe(false);
            // A spread in the query object can select another row, so its id is not the caller's either.
            expect(
                isScopedByIdentity(
                    sinkArgument(
                        `const row = await ctx.db.files.findFirst({ where: { ownerId: ctx.auth.userId }, ...args.query });\nSINK(\`\${row!._id}/\${args.key ?? args.other}\`);`,
                    ),
                ),
            ).toBe(false);
            expect(isScopedByIdentity(sinkArgument(`${owned}Object.assign(row, args.patch);\n${sink}`))).toBe(false);
            // Reading fields, including by destructuring, leaves the row intact.
            expect(isScopedByIdentity(sinkArgument(`${owned}const { status } = row;\n${sink}`))).toBe(true);

            // The owner value must be the caller id, not an expression that merely mentions it.
            expect(
                isScopedByIdentity(
                    sinkArgument(
                        `const row = await ctx.db.files.findFirst({ where: { ownerId: args.ownerId + ctx.auth.userId.slice(0, 0) } });\nSINK(\`\${row.ownerId}/\${args.key ?? args.other}\`);`,
                    ),
                ),
            ).toBe(false);
            expect(
                isScopedByIdentity(
                    sinkArgument(
                        `const row = await ctx.db.files.findFirst({ where: { ownerId: { eq: args.ownerId ?? ctx.auth.userId } } });\nSINK(\`\${row.ownerId}/\${args.key ?? args.other}\`);`,
                    ),
                ),
            ).toBe(false);

            expect(
                isScopedByIdentity(
                    sinkArgument(
                        `const row = await ctx.db.files.findFirst({ where: { ownerId: ctx.auth.userId, [args.field]: args.ownerId } });\nSINK(\`\${row.ownerId}/\${args.key ?? args.other}\`);`,
                    ),
                ),
            ).toBe(false);
            expect(
                isScopedByIdentity(sinkArgument(`const row = await ctx.db.files.findFirst({ where: { ownerId: ctx.auth.userId, ...args.where } });\n${sink}`)),
            ).toBe(false);
            expect(
                isScopedByIdentity(
                    sinkArgument(
                        `const filter = { ownerId: ctx.auth.userId };\nfilter.ownerId = args.owner;\nconst row = await ctx.db.files.findFirst({ where: filter });\n${sink}`,
                    ),
                ),
            ).toBe(false);
            expect(
                isScopedByIdentity(
                    sinkArgument(
                        `const filter = { ownerId: ctx.auth.userId };\nObject.assign(filter, args.where);\nconst row = await ctx.db.files.findFirst({ where: filter });\n${sink}`,
                    ),
                ),
            ).toBe(false);
            expect(
                isScopedByIdentity(
                    sinkArgument(
                        `const row = await ctx.db.files.findFirst({ where: { AND: [{ ownerId: { ne: ctx.auth.userId } }, { status: "active" }] } });\n${sink}`,
                    ),
                ),
            ).toBe(false);
            expect(
                isScopedByIdentity(sinkArgument(`const row = await ctx.db.files.findFirst({ where: { ownerId: { eq: ctx.auth.userId } } });\n${sink}`)),
            ).toBe(true);
        });

        it("counts only a direct predicate of the read's own where as an identity column", () => {
            expect.assertions(2);

            expect(
                isScopedByIdentity(
                    sinkArgument(
                        `const row = await ctx.db.files.findFirst({ where: { author: { ownerId: ctx.auth.userId } } });\nSINK(\`\${row.ownerId}/\${args.key ?? args.other}\`);`,
                    ),
                ),
            ).toBe(false);
            expect(
                isScopedByIdentity(
                    sinkArgument(
                        `const row = await ctx.db.files.findFirst({ where: { OR: [{ ownerId: ctx.auth.userId }, { id: args.id }] } });\nSINK(\`\${row.ownerId}/\${args.k}\`);`,
                    ),
                ),
            ).toBe(false);
        });

        it("rejects a shared column of the caller's own row as a key prefix", () => {
            expect.assertions(4);

            const me = `const me = await ctx.db.users.get(ctx.auth.userId);\n`;

            expect(isScopedByIdentity(sinkArgument(`${me}SINK(\`\${me.plan}/\${args.k}\`);`))).toBe(false);
            expect(isScopedByIdentity(sinkArgument(`${me}const prefix = me.locale;\nSINK(\`\${prefix}/\${args.k}\`);`))).toBe(false);
            expect(
                isScopedByIdentity(
                    sinkArgument(`const { plan } = await ctx.db.users.findFirst({ where: { _id: ctx.auth.userId } });\nSINK(\`\${plan}/\${args.k}\`);`),
                ),
            ).toBe(false);
            expect(isScopedByIdentity(sinkArgument(`SINK(\`\${(await ctx.db.users.findFirst({ where: { _id: ctx.auth.userId } })).plan}/\${args.k}\`);`))).toBe(
                false,
            );
        });

        it("rejects a key read off a database write, even one that stamps the caller's identity", () => {
            expect.assertions(1);

            expect(
                isScopedByIdentity(
                    sinkArgument(
                        `const row = await ctx.db.files.update({ where: { id: args.fileId }, data: { lastDownloadedBy: ctx.auth.userId } });\nSINK(row.key);`,
                    ),
                ),
            ).toBe(false);
        });

        it("rejects a key read off a database row the caller selected by id", () => {
            expect.assertions(1);

            expect(isScopedByIdentity(sinkArgument(`const row = await ctx.db.get("files", args.id);\nSINK(row.key);`))).toBe(false);
        });

        it("accepts a caller fallback whose alternatives all land after the identity prefix", () => {
            expect.assertions(8);

            expect(isScopedByIdentity(sinkArgument(`SINK(ctx.auth.userId + "/" + args.folder + "/" + (args.key ?? args.other));`))).toBe(true);

            expect(isScopedByIdentity(sinkArgument(`SINK(\`\${ctx.auth.userId + "/".repeat(1)}\${args.key ?? args.other}\`);`))).toBe(true);
            expect(isScopedByIdentity(sinkArgument(`const uid = ctx.auth.userId;\nSINK(\`\${uid!}/\${args.key ?? args.other}\`);`))).toBe(true);
            expect(
                isScopedByIdentity(
                    sinkArgument(`SINK(\`\${(await ctx.db.files.findFirst({ where: { ownerId: ctx.auth.userId } }))._id}/\${args.key ?? args.other}\`);`),
                ),
            ).toBe(true);

            expect(isScopedByIdentity(sinkArgument(`SINK(\`\${ctx.auth.userId}/\${args.key ?? args.other}\`);`))).toBe(true);
            expect(isScopedByIdentity(sinkArgument(`const uid = ctx.auth.userId;\nSINK(\`\${uid}/\${args.key || "default"}\`);`))).toBe(true);
            expect(isScopedByIdentity(sinkArgument(`SINK(ctx.auth.userId + "/" + (args.key ?? args.other));`))).toBe(true);
            expect(isScopedByIdentity(sinkArgument(`const k = \`\${ctx.auth.userId}/\${args.flag ? args.a : args.b}\`;\nSINK(k);`))).toBe(true);
        });

        it("rejects a caller fallback that can supply the whole key or the segment before the identity", () => {
            expect.assertions(6);

            expect(isScopedByIdentity(sinkArgument(`SINK(\`\${args.tenant}/\${ctx.auth.userId}/\${args.key ?? args.other}\`);`))).toBe(false);
            expect(isScopedByIdentity(sinkArgument(`SINK(args.tenant + "/" + ctx.auth.userId + "/" + (args.key ?? args.other));`))).toBe(false);

            expect(isScopedByIdentity(sinkArgument(`SINK(args.key ?? \`\${ctx.auth.userId}/x\`);`))).toBe(false);
            expect(isScopedByIdentity(sinkArgument(`SINK(\`\${args.key ?? args.other}/\${ctx.auth.userId}\`);`))).toBe(false);
            expect(isScopedByIdentity(sinkArgument(`SINK((args.key ?? args.other) + "/" + ctx.auth.userId);`))).toBe(false);
            expect(isScopedByIdentity(sinkArgument(`SINK(\`\${ctx.env.PREFIX}/\${args.key ?? args.other}\`);`))).toBe(false);
        });

        it("rejects a key scoped only by a server-trusted ctx value that names no caller", () => {
            expect.assertions(3);

            expect(isScopedByIdentity(sinkArgument(`SINK(\`\${ctx.env.PREFIX}/\${args.k}\`);`))).toBe(false);
            expect(isScopedByIdentity(sinkArgument(`SINK(\`\${ctx.now}-\${args.k}\`);`))).toBe(false);
            expect(isScopedByIdentity(sinkArgument(`SINK(args.k);`))).toBe(false);
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

    describe("callSiteScopeOf", () => {
        it("attributes a sink to the exported declaration, walking past local bindings", () => {
            expect.assertions(2);

            expect(callSiteScopeOf(sinkArgument(`const result = SINK(args.key);`))).toStrictEqual({ kind: "export", name: "handler" });

            const inline = project.createSourceFile("inline.ts", `router.route("/x", async () => { SINK(1); });\n`, { overwrite: true });

            expect(callSiteScopeOf(findSink(inline))).toStrictEqual({ kind: "module" });
        });
    });
});
