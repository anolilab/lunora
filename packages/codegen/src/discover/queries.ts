import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { enclosingExportName } from "../argument-taint";
import type { QueryReadIR } from "../ir";
import { listLunoraSourceFiles, lunoraRelativePath } from "./ast";

/**
 * Chain methods that narrow a read so it is not a full scan.
 *
 * `withGeoIndex` belongs here for the same reason as the other two: it resolves
 * a geohash-prefix range plus a distance refine, never a table scan. It was
 * missing while this feeder only reported `.filter()` reads — a geo query is
 * normally written without one, so nothing could observe the gap. Once
 * unfiltered reads are reported (for `unbounded_collect`), omitting it would
 * flag the idiomatic `withGeoIndex(...).collect()` as an unbounded scan, which
 * `geo_index_unused` tells authors to write in the first place.
 */
const INDEX_METHODS = new Set(["withGeoIndex", "withIndex", "withSearchIndex"]);

/**
 * Chain methods that MATERIALIZE a read — the point at which how much of the
 * narrowed set is actually loaded gets decided.
 *
 * Matched as a known set rather than taken as the chain's last call.
 * {@link chainMethods} follows any property-access-then-call parent, and a
 * terminal returns a Promise, so `.collect().then(...)` / `.catch(...)` keep the
 * walk going and the last call is a combinator rather than the terminal. Taking
 * the last RECOGNISED terminal reports `collect` for that chain instead of
 * `then`; a chain with none (`.order("desc")` handed on, or a bare
 * `query(...)`) reports `undefined`, which the terminal-shaped lints skip.
 */
const TERMINAL_METHODS = new Set(["collect", "collectWithScores", "first", "paginate", "take", "unique"]);

/**
 * True for a `ctx.db.query(...)` (or bare `db.query(...)`) call — the database
 * read entry point. The receiver must be `.db` so unrelated `.query(...)` calls
 * and the `ctx.db.system.query(...)` system reader (receiver `system`) don't match.
 */
const isDatabaseQueryCall = (call: CallExpression): boolean => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "query") {
        return false;
    }

    const receiver = callee.getExpression();

    if (Node.isPropertyAccessExpression(receiver)) {
        return receiver.getName() === "db";
    }

    return Node.isIdentifier(receiver) && receiver.getText() === "db";
};

/**
 * Walk the fluent chain rooted at a `query(...)` call and collect the method
 * names invoked on it. A `query(...)` call can only ever be the *expression* of
 * the enclosing `PropertyAccessExpression` (never its name), so reaching a
 * property-access parent followed by a call parent unambiguously continues the
 * chain — `query("t").withIndex(...).filter(...)` yields `["withIndex", "filter"]`.
 */
const chainMethods = (queryCall: CallExpression): string[] => {
    const methods: string[] = [];
    let node: TsNode = queryCall;

    for (;;) {
        const parent = node.getParent();

        if (!parent || !Node.isPropertyAccessExpression(parent)) {
            break;
        }

        const callParent = parent.getParent();

        if (!callParent || !Node.isCallExpression(callParent)) {
            break;
        }

        methods.push(parent.getName());
        node = callParent;
    }

    return methods;
};

/**
 * A `.filter()` predicate that compares the primary key: `(d) => d._id === x`.
 *
 * Matched on the predicate's source text rather than its AST — the shapes are
 * few and fixed, and a false negative costs only a missed nudge.
 */
// Equality ONLY. `[!=]==?` also matched `!==`, and `.filter((d) => d._id !== x)`
// — "every row except this one" — is a legitimate read that `ctx.db.get(id)`
// cannot express, so flagging it inverted the query the remediation suggested.
// The lint's whole claim is that it needs no triage; inequality breaks that.
const PRIMARY_KEY_PREDICATE_RE = /\b[A-Za-z_$][\w$]*\._id\s*===?[^=]/u;

/**
 * Whether the chain's `.filter()` predicate tests `_id`.
 *
 * `.query("user").filter((d) => d._id === args.userId).first()` is a full scan
 * for a row that is directly addressable by `ctx.db.get` — always wrong, never
 * a judgement call, and invisible to `filter_without_index`, which sees only
 * that a filter has no index.
 */
const filtersPrimaryKeyOf = (queryCall: CallExpression): boolean => {
    let node: TsNode = queryCall;

    for (;;) {
        const parent = node.getParent();

        if (!parent || !Node.isPropertyAccessExpression(parent)) {
            return false;
        }

        const callParent = parent.getParent();

        if (!callParent || !Node.isCallExpression(callParent)) {
            return false;
        }

        if (parent.getName() === "filter") {
            const predicate = callParent.getArguments()[0];

            if (predicate && PRIMARY_KEY_PREDICATE_RE.test(predicate.getText())) {
                return true;
            }
        }

        node = callParent;
    }
};

/** The literal table name from a `query("table")` call, or `""` when the argument is not a string literal. */
const tableOf = (queryCall: CallExpression): string => {
    const argument = queryCall.getArguments()[0];

    return argument && Node.isStringLiteral(argument) ? argument.getLiteralText() : "";
};

/**
 * Discover every `ctx.db.query("table")…` read under the lunora source directory
 * and reduce each to a {@link QueryReadIR}.
 *
 * Reads without a `.filter()` are kept too. They are never
 * `filter_without_index` candidates (that lint gates on `hasFilter`), but an
 * unfiltered, unindexed `.collect()` is the read `unbounded_collect` exists for
 * — and dropping it here is precisely why nothing could see it.
 */
const discoverQueries = (project: Project, lunoraDirectory: string): QueryReadIR[] => {
    const reads: QueryReadIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            if (!isDatabaseQueryCall(call)) {
                continue;
            }

            const methods = chainMethods(call);
            const hasFilter = methods.includes("filter");

            reads.push({
                exportName: enclosingExportName(call),
                file: relativePath,
                filtersPrimaryKey: hasFilter && filtersPrimaryKeyOf(call),
                hasFilter,
                hasIndex: methods.some((method) => INDEX_METHODS.has(method)),
                line: call.getStartLineNumber(),
                table: tableOf(call),
                terminal: methods.findLast((method) => TERMINAL_METHODS.has(method)),
            });
        }
    }

    return reads;
};

export default discoverQueries;
