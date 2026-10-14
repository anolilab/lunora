import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node } from "ts-morph";

import type { CountReadIR, TableIR } from "../ir";
import { collectCallRows } from "./ast";
import { callSiteScopeOf } from "./attribution";
import { isDatabaseAccessor } from "./database-calls";

/**
 * The table a `count(...)` call counts, or `undefined` when the call is not a `ctx.db`
 * count. Two shapes: the table-name form `ctx.db.count("table", …)`, where the table is
 * the string argument, and the facade form `ctx.db.<table>.count(…)`, where it is the
 * receiver's property name. `""` for a table-name form whose argument is not a literal.
 */
const countTargetOf = (call: CallExpression): string | undefined => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "count") {
        return undefined;
    }

    const receiver = callee.getExpression();

    if (isDatabaseAccessor(receiver)) {
        const argument = call.getArguments()[0];

        return argument && Node.isStringLiteral(argument) ? argument.getLiteralText() : "";
    }

    return Node.isPropertyAccessExpression(receiver) && isDatabaseAccessor(receiver.getExpression()) ? receiver.getName() : undefined;
};

/**
 * The `where` argument of a count call: the second argument of the table-name form
 * `ctx.db.count("table", where)`, the first of the facade form `ctx.db.<table>.count(where)`.
 */
const whereArgumentOf = (call: CallExpression): TsNode | undefined => {
    const callee = call.getExpression();
    const receiver = Node.isPropertyAccessExpression(callee) ? callee.getExpression() : undefined;

    return call.getArguments()[receiver !== undefined && isDatabaseAccessor(receiver) ? 1 : 0];
};

/** Keys that make a count argument an options object rather than a `where`, as the runtime's `normalizeCountArgument` reads them. */
const COUNT_OPTION_KEYS = new Set(["baseWhere", "relationBaseWhere", "restrictsCounts", "where"]);

/**
 * The field names of a `where` object literal, or `undefined` when the argument is absent,
 * not a literal, spreads, uses an `AND`/`OR`/`NOT` key, or is an options object (every key a
 * count option), since then the fields are not all named here.
 */
const whereFieldsOf = (where: TsNode | undefined): string[] | undefined => {
    if (where === undefined || !Node.isObjectLiteralExpression(where)) {
        return undefined;
    }

    const fields: string[] = [];

    for (const property of where.getProperties()) {
        if (!Node.isPropertyAssignment(property) && !Node.isShorthandPropertyAssignment(property)) {
            return undefined;
        }

        fields.push(property.getName());
    }

    const isOptions = fields.length > 0 && fields.every((field) => COUNT_OPTION_KEYS.has(field));

    return isOptions || fields.some((field) => field === "AND" || field === "OR" || field === "NOT") ? undefined : fields;
};

/**
 * Discover the `count()` calls under the lunora source directory, one record per call with
 * its `CallSiteScope`. `tables` supplies each table's aggregate-index flag: a table that is
 * not in the schema reads as indexed, since its count cannot be judged.
 */
const discoverCountReads = (project: Project, lunoraDirectory: string, tables: ReadonlyArray<TableIR>): CountReadIR[] => {
    const indexed = new Map(tables.map((table) => [table.name, table.aggregateIndexed === true] as const));

    return collectCallRows(project, lunoraDirectory, (call, file): CountReadIR | undefined => {
        const table = countTargetOf(call);

        if (table === undefined) {
            return undefined;
        }

        const filterFields = whereFieldsOf(whereArgumentOf(call));

        return {
            file,
            indexed: indexed.get(table) !== false,
            ...(filterFields === undefined ? {} : { filterFields }),
            line: call.getStartLineNumber(),
            scope: callSiteScopeOf(call),
            table,
        };
    });
};

export default discoverCountReads;
