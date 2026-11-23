import type { NestedWith, RelationDefinitionLike, SchemaLike, WhereInput, WithInput } from "@lunora/shard-engine";

/** The operators of a relation predicate node; any other key under a relation name is not one. */
const RELATION_PREDICATE_KEYS: ReadonlySet<string> = new Set(["every", "is", "isNot", "none", "some"]);

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";

type Visit = (tableName: string, withInput: WithInput | undefined, where: WhereInput | undefined) => void;

const visitRelation = (reached: Set<string>, visit: Visit, relation: RelationDefinitionLike, nested?: NestedWith): void => {
    if (relation.through !== undefined) {
        reached.add(relation.through.table);
    }

    visit(relation.table, nested?.with, nested?.where);
};

const visitRelationPredicate = (reached: Set<string>, visit: Visit, relation: RelationDefinitionLike, node: unknown): void => {
    if (!isObject(node)) {
        return;
    }

    for (const [operator, inner] of Object.entries(node)) {
        if (RELATION_PREDICATE_KEYS.has(operator)) {
            visitRelation(reached, visit, relation, { where: inner as WhereInput });
        }
    }
};

const visitWhere = (schema: SchemaLike, reached: Set<string>, visit: Visit, tableName: string, clause: unknown): void => {
    if (!isObject(clause)) {
        return;
    }

    for (const [key, value] of Object.entries(clause)) {
        if (key === "AND" || key === "OR" || key === "NOT") {
            for (const branch of Array.isArray(value) ? value : [value]) {
                visitWhere(schema, reached, visit, tableName, branch);
            }

            continue;
        }

        const relation = schema.tables[tableName]?.relationMap?.[key];

        if (relation !== undefined) {
            visitRelationPredicate(reached, visit, relation, value);
        }
    }
};

const visitWith = (schema: SchemaLike, reached: Set<string>, visit: Visit, tableName: string, withInput: WithInput | undefined): void => {
    const relationMap = schema.tables[tableName]?.relationMap ?? {};

    for (const [name, value] of Object.entries(withInput ?? {})) {
        if (value === undefined || value === false) {
            continue;
        }

        // `_count` names the counted relations; its values are flags, never nested reads.
        const targets =
            name === "_count" ? Object.keys(value as Record<string, true>).map((counted) => [counted, undefined] as const) : [[name, value] as const];

        for (const [relationName, nested] of targets) {
            const relation = relationMap[relationName];

            if (relation !== undefined) {
                visitRelation(reached, visit, relation, nested === undefined || nested === true ? undefined : nested);
            }
        }
    }
};

/**
 * Every table a read of `table` with `withInput` and `where` can load through a relation: the
 * table itself, each `with`/`_count` target (and a many-to-many join table) down the nested
 * `with`s, and the targets of relation predicates in any `where` along the way.
 */
const relationReachableTables = (table: string, withInput: WithInput | undefined, where: WhereInput | undefined, schema: SchemaLike): Set<string> => {
    const reached = new Set<string>();

    const visit: Visit = (tableName, nestedWith, nestedWhere) => {
        reached.add(tableName);
        visitWhere(schema, reached, visit, tableName, nestedWhere);
        visitWith(schema, reached, visit, tableName, nestedWith);
    };

    visit(table, withInput, where);

    return reached;
};

/**
 * The read policy of every table a cross-shard hop can read, keyed by table, for the serving shard
 * to apply there. Only reachable tables are asked: `relationBaseWhere` refuses a protected table no
 * policy reads, and asking it about every table in the schema made an unrelated one fail a read
 * that never touches it. A policy can itself filter by a relation, and the serving shard resolves
 * that predicate too, so each policy's targets join the set until it stops growing; one left out
 * would be read there with no policy at all.
 */
const projectRelationPolicies = (
    table: string,
    withInput: WithInput | undefined,
    where: WhereInput | undefined,
    schema: SchemaLike,
    relationBaseWhere: (table: string) => WhereInput | undefined,
): Record<string, WhereInput> => {
    const policies: Record<string, WhereInput> = {};
    const pending = [...relationReachableTables(table, withInput, where, schema)];
    const reached = new Set(pending);

    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        const policy = relationBaseWhere(next);

        if (policy !== undefined) {
            policies[next] = policy;

            for (const target of relationReachableTables(next, undefined, policy, schema)) {
                if (!reached.has(target)) {
                    reached.add(target);
                    pending.push(target);
                }
            }
        }
    }

    return policies;
};

export default projectRelationPolicies;
