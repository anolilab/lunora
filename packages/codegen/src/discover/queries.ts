import type { CallExpression, Expression, Node as TsNode, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { FunctionIR, QueryReadIR } from "../ir";
import { collectCallRows } from "./ast";
import { callSiteScopeOf, withCallerVisibility } from "./attribution";
import { isDatabaseAccessor } from "./database-calls";

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
 * {@link chainCalls} follows any property-access-then-call parent, and a
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

    return isDatabaseAccessor(receiver);
};

/**
 * Walk the fluent chain rooted at a `query(...)` call and collect the calls made
 * on it, in chain order. A `query(...)` call can only ever be the *expression* of
 * the enclosing `PropertyAccessExpression` (never its name), so reaching a
 * property-access parent followed by a call parent unambiguously continues the
 * chain — `query("t").withIndex(...).filter(...)` yields the two calls.
 */
const chainCalls = (queryCall: CallExpression): CallExpression[] => {
    const calls: CallExpression[] = [];
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

        calls.push(callParent);
        node = callParent;
    }

    return calls;
};

/** The method name a chain call invokes, or `""` when the callee is not a property access. */
const methodNameOf = (call: CallExpression): string => {
    const callee = call.getExpression();

    return Node.isPropertyAccessExpression(callee) ? callee.getName() : "";
};

/** The first parameter name of a function literal, or `undefined` when it is not one or destructures. */
const rowParameterOf = (argument: TsNode | undefined): string | undefined => {
    if (argument === undefined || !(Node.isArrowFunction(argument) || Node.isFunctionExpression(argument))) {
        return undefined;
    }

    const name = argument.getParameters()[0]?.getNameNode();

    return name !== undefined && Node.isIdentifier(name) ? name.getText() : undefined;
};

/** The innermost receiver of a call or property-access chain: `q` for `q.gt(…).lt(…)`. */
const chainRoot = (node: TsNode): TsNode => {
    let current = node;

    while (Node.isCallExpression(current) || Node.isPropertyAccessExpression(current)) {
        current = current.getExpression();
    }

    return current;
};

/** The comparators a chain on `parameter` calls anywhere inside `expression`. */
const comparatorsIn = (expression: TsNode, parameter: string): Set<string> => {
    const comparators = new Set<string>();

    // The expression itself can be the call (`(q) => q.gt(…)`), which its descendants never include.
    const calls = [expression, ...expression.getDescendantsOfKind(SyntaxKind.CallExpression)].filter((node) => Node.isCallExpression(node));

    for (const call of calls) {
        const callee = call.getExpression();

        // `q.gt(…).lt(…)` chains, so the root of a comparator is found by walking its receivers, not read one level down.
        if (Node.isPropertyAccessExpression(callee)) {
            const root = chainRoot(callee);

            if (Node.isIdentifier(root) && root.getText() === parameter) {
                comparators.add(callee.getName());
            }
        }
    }

    return comparators;
};

/**
 * The comparators every range one expression can return applies. A conditional
 * returns one of two ranges, so only a comparator present on both branches bounds it.
 */
const boundsOfExpression = (expression: TsNode, parameter: string): Set<string> => {
    if (Node.isParenthesizedExpression(expression)) {
        return boundsOfExpression(expression.getExpression(), parameter);
    }

    if (Node.isConditionalExpression(expression)) {
        const whenFalse = boundsOfExpression(expression.getWhenFalse(), parameter);

        return new Set([...boundsOfExpression(expression.getWhenTrue(), parameter)].filter((bound) => whenFalse.has(bound)));
    }

    return comparatorsIn(expression, parameter);
};

/**
 * The expressions a range callback returns: its body when it is an expression, or the
 * values of its `return` statements. `undefined` when the callback is not a function
 * literal, or returns nothing the feeder can read.
 */
const returnedExpressionsOf = (callback: TsNode): Expression[] | undefined => {
    if (!(Node.isArrowFunction(callback) || Node.isFunctionExpression(callback))) {
        return undefined;
    }

    const body = callback.getBody();

    if (!Node.isBlock(body)) {
        return Node.isExpression(body) ? [body] : undefined;
    }

    const returned = body
        .getDescendantsOfKind(SyntaxKind.ReturnStatement)
        .filter(
            (statement) =>
                statement.getFirstAncestor((ancestor) => Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor))?.compilerNode ===
                callback.compilerNode,
        )
        .map((statement) => statement.getExpression())
        .filter((expression): expression is Expression => expression !== undefined);

    return returned.length === 0 ? undefined : returned;
};

/**
 * The comparators an `.withIndex(…)` range callback applies on every range it can
 * return, sorted and de-duplicated. `(q) => q.eq("a", x).lt("b", y)` gives `eq`, `lt`.
 * `undefined` when the callback has no readable return.
 */
const indexBoundsOf = (callback: TsNode, parameter: string): string[] | undefined => {
    const returned = returnedExpressionsOf(callback);

    if (returned === undefined) {
        return undefined;
    }

    const [first, ...rest] = returned.map((expression) => boundsOfExpression(expression, parameter));
    const shared = [...(first ?? new Set<string>())].filter((bound) => rest.every((set) => set.has(bound)));

    return shared.toSorted((a, b) => a.localeCompare(b));
};

/** The fields a `.filter(…)` predicate reads off its row parameter. */
const filterFieldsOf = (predicate: TsNode, parameter: string): string[] => {
    const fields = new Set<string>();

    for (const access of predicate.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        const receiver = access.getExpression();

        if (Node.isIdentifier(receiver) && receiver.getText() === parameter) {
            fields.add(access.getName());
        }
    }

    // `row["status"]` reads the same field as `row.status`, when the key is a literal.
    for (const access of predicate.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
        const receiver = access.getExpression();
        const key = access.getArgumentExpression();

        if (Node.isIdentifier(receiver) && receiver.getText() === parameter && key !== undefined && Node.isStringLiteral(key)) {
            fields.add(key.getLiteralText());
        }
    }

    return [...fields];
};

/**
 * The `.withIndex(…)` of a chain: its literal name, and the comparators its range
 * callback calls. A `.withIndex(name)` with no callback is the widest range there
 * is, so its bounds are `[]`. Bounds are `undefined` when the callback exists but
 * cannot be read. The whole field is absent when the chain has no `.withIndex(…)`.
 */
const indexOf = (withIndex: CallExpression | undefined): QueryReadIR["index"] => {
    if (withIndex === undefined) {
        return undefined;
    }

    const [nameArgument, callback] = withIndex.getArguments();
    const parameter = rowParameterOf(callback);
    const name = nameArgument !== undefined && Node.isStringLiteral(nameArgument) ? nameArgument.getLiteralText() : undefined;

    if (callback === undefined) {
        return { bounds: [], name };
    }

    return { bounds: parameter === undefined ? undefined : indexBoundsOf(callback, parameter), name };
};

/**
 * The fields every literal `.filter(…)` predicate of a chain reads, sorted and
 * de-duplicated. A chain can filter more than once, and each predicate's fields
 * count. `undefined` when the chain has no filter, or none of its predicates is a
 * function literal the feeder can read.
 */
const filterFieldsOfChain = (filters: ReadonlyArray<CallExpression>): string[] | undefined => {
    const readable = filters.flatMap((call) => {
        const predicate = call.getArguments()[0];
        const parameter = rowParameterOf(predicate);

        return predicate === undefined || parameter === undefined ? [] : filterFieldsOf(predicate, parameter);
    });

    if (readable.length === 0) {
        return undefined;
    }

    return [...new Set(readable)].toSorted((a, b) => a.localeCompare(b));
};

/**
 * A `.filter()` predicate that compares the primary key: `(d) => d._id === x`.
 *
 * Matched on the predicate's source text rather than its AST — the shapes are
 * few and fixed, and a false negative costs only a missed nudge.
 */
// Equality ONLY. `[!=]==?` also matched `!==`, and `.filter((d) => d._id !== x)`
// — "every row except this one" — is a legitimate read that `ctx.db.get(table, id)`
// cannot express, so flagging it inverted the query the remediation suggested.
// The lint's whole claim is that it needs no triage; inequality breaks that.
const PRIMARY_KEY_PREDICATE_RE = /\b[A-Za-z_$][\w$]*\._id\s*===?[^=]/u;

/**
 * Whether any of the chain's `.filter()` predicates tests `_id`.
 *
 * `.query("user").filter((d) => d._id === args.userId).first()` is a full scan
 * for a row that is directly addressable by `ctx.db.get` — always wrong, never
 * a judgement call, and invisible to `filter_without_index`, which sees only
 * that a filter has no index.
 */
const filtersPrimaryKeyOf = (calls: ReadonlyArray<CallExpression>): boolean =>
    calls.some((call) => methodNameOf(call) === "filter" && PRIMARY_KEY_PREDICATE_RE.test(call.getArguments()[0]?.getText() ?? ""));

/** The literal table name from a `query("table")` call, or `""` when the argument is not a string literal. */
const tableOf = (queryCall: CallExpression): string => {
    const argument = queryCall.getArguments()[0];

    return argument && Node.isStringLiteral(argument) ? argument.getLiteralText() : "";
};

/**
 * Discover every `ctx.db.query("table")…` read under the lunora source directory
 * and reduce each to a {@link QueryReadIR}, one per read site with its
 * `CallSiteScope`.
 *
 * Reads without a `.filter()` are kept too. They are never
 * `filter_without_index` candidates (that lint gates on `hasFilter`), but an
 * unfiltered, unindexed `.collect()` is the read `unbounded_collect` exists for
 * — and dropping it here is precisely why nothing could see it.
 */
const discoverQueries = (project: Project, lunoraDirectory: string, functions: ReadonlyArray<FunctionIR> = []): QueryReadIR[] => {
    const reads = collectCallRows(project, lunoraDirectory, (call, file): QueryReadIR | undefined => {
        if (!isDatabaseQueryCall(call)) {
            return undefined;
        }

        const calls = chainCalls(call);
        const methods = calls.map((chained) => methodNameOf(chained));
        const filters = calls.filter((chained) => methodNameOf(chained) === "filter");
        const hasFilter = filters.length > 0;

        return {
            file,
            filterFields: hasFilter ? filterFieldsOfChain(filters) : undefined,
            filtersPrimaryKey: hasFilter && filtersPrimaryKeyOf(calls),
            hasFilter,
            hasIndex: methods.some((method) => INDEX_METHODS.has(method)),
            index: indexOf(calls.find((chained) => methodNameOf(chained) === "withIndex")),
            line: call.getStartLineNumber(),
            scope: callSiteScopeOf(call),
            table: tableOf(call),
            terminal: methods.findLast((method) => TERMINAL_METHODS.has(method)),
        };
    });

    return withCallerVisibility(reads, functions);
};

export default discoverQueries;
