import type { CallExpression, Project } from "ts-morph";
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

        return {
            file,
            indexed: indexed.get(table) !== false,
            line: call.getStartLineNumber(),
            scope: callSiteScopeOf(call),
            table,
        };
    });
};

export default discoverCountReads;
