import type { AdvisorIndex, AdvisorSchema, Finding } from "@cirrus/advisor";
import { runAdvisor } from "@cirrus/advisor";

import type { AuthApiCallIR, InsertWriteIR, QueryReadIR, RlsProcedureIR, SchemaIR, TableIR } from "./ir";

/**
 * Flatten a table's per-kind index declarations into the advisor's unified
 * {@link AdvisorIndex} list, tagging each with its `kind` and the columns it
 * touches (a search index's text + filter fields, a rank index's sort +
 * partition fields, a vector index's source field). Inline vector indexes on a
 * table always carry a `field`; the guard drops the Shape-B standalone form
 * (which derives text via a `select` fn and has no column to lint).
 */
const flattenIndexes = (table: TableIR): AdvisorIndex[] => [
    ...table.indexes.map((index): AdvisorIndex => {
        return { fields: index.fields, kind: "index", name: index.name, unique: index.unique };
    }),
    ...table.searchIndexes.map((index): AdvisorIndex => {
        return { fields: [index.field, ...(index.filterFields ?? [])], kind: "search", name: index.name };
    }),
    ...table.rankIndexes.map((index): AdvisorIndex => {
        return { fields: [...index.sortBy.map((key) => key.field), ...(index.partitionBy ?? [])], kind: "rank", name: index.name };
    }),
    ...table.vectorIndexes
        .filter((index) => index.field !== undefined)
        .map((index): AdvisorIndex => {
            return { fields: [index.field as string], kind: "vector", name: index.name };
        }),
];

/**
 * Collapse the AST-derived {@link SchemaIR} into the advisor's feeder-agnostic
 * {@link AdvisorSchema}. The IR already carries exactly what static lints read —
 * each table's columns (the `shape` keys), relations, and indexes. Codegen never
 * imports `@cirrus/server`, so it builds the advisor input from its own IR
 * rather than going through `fromServerSchema`.
 */
const toAdvisorSchema = (schema: SchemaIR): AdvisorSchema => {
    return {
        tables: schema.tables.map((table) => {
            return {
                fields: Object.keys(table.shape),
                indexes: flattenIndexes(table),
                name: table.name,
                relations: table.relations.map((relation) => {
                    return {
                        field: relation.field,
                        kind: relation.kind,
                        name: relation.name,
                        onDelete: relation.onDelete,
                        references: relation.references,
                        table: relation.table,
                    };
                }),
            };
        }),
    };
};

/**
 * Run the static lints against a discovered {@link SchemaIR} and the reads/writes/calls
 * found in function bodies: query reads feed `filter_without_index`, insert writes
 * feed `table_without_insert`, authApi calls feed `auth_api_call_without_headers`,
 * and rls procedure snapshots feed `rls_uncovered_table`
 * (all default empty for callers that don't analyze functions).
 * The IR types are structurally identical to the advisor's evidence types so they
 * pass straight through without conversion. Returns the findings; surfacing them
 * (console, error overlay, studio Advisors table) is the caller's choice.
 */
export const lintSchema = (
    schema: SchemaIR,
    queries: ReadonlyArray<QueryReadIR> = [],
    inserts?: ReadonlyArray<InsertWriteIR>,
    authApiCalls?: ReadonlyArray<AuthApiCallIR>,
    rlsProcedures?: ReadonlyArray<RlsProcedureIR>,
): Finding[] => runAdvisor({ authApiCalls, inserts, queries, rlsProcedures, schema: toAdvisorSchema(schema) }, { source: "static" });

/**
 * Render advisor findings as a single multi-line string for console surfacing:
 * a one-line summary header followed by one `[LEVEL] name: detail` line per
 * finding. Returns `""` when there are no findings.
 */
export const formatAdvisories = (findings: ReadonlyArray<Finding>): string => {
    if (findings.length === 0) {
        return "";
    }

    const header = `@cirrus/codegen: ${String(findings.length)} schema advisor finding${findings.length === 1 ? "" : "s"}`;
    const lines = findings.map((finding) => `  [${finding.level}] ${finding.name}: ${finding.detail}`);

    return [header, ...lines].join("\n");
};
