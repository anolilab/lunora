/**
 * The one dataset every store runs the mixed-type path range against: the Durable Object store and the SQLite
 * `.global()` store (`@lunora/shard-engine`, `@lunora/sql-store`), Postgres and MySQL (`@lunora/hyperdrive`) and the
 * in-memory rls evaluator (`@lunora/server`). The ids in {@link MIX_QUERIES} are the contract: a range over a path
 * matches the leaves of its operand's own type and no others, so every backend must return exactly these rows.
 */

/** `[id, profile]`: one row per JSON type of the `profile.mix` leaf, plus a missing one. */
const MIX_ROWS: [string, Record<string, unknown>][] = [
    ["n1", { mix: 5 }],
    ["n2", { mix: 50 }],
    ["n3", { mix: -1 }],
    ["s1", { mix: "7" }],
    ["s2", { mix: "abc" }],
    ["s3", { mix: "100" }],
    ["b1", { mix: true }],
    ["b2", { mix: false }],
    ["z", { mix: null }],
    ["o", { mix: { x: 1 } }],
    ["l", { mix: [1] }],
    ["m", {}],
];

const byId = (left: string, right: string): number => left.localeCompare(right);

const MIX_QUERIES: [string, Record<string, unknown>, string[]][] = [
    ["number leaves above a number", { "profile.mix": { gt: 5 } }, ["n2"]],
    ["number leaves from a number", { "profile.mix": { gte: 5 } }, ["n1", "n2"]],
    ["number leaves below a number", { "profile.mix": { lt: 5 } }, ["n3"]],
    ["number leaves up to a number", { "profile.mix": { lte: 5 } }, ["n1", "n3"]],
    ["number leaves between two numbers", { "profile.mix": { gt: 0, lt: 100 } }, ["n1", "n2"]],
    ["text leaves above a string", { "profile.mix": { gt: "7" } }, ["s2"]],
    ["text leaves below a string", { "profile.mix": { lt: "7" } }, ["s3"]],
    ["text leaves from a string", { "profile.mix": { gte: "7" } }, ["s1", "s2"]],
    ["boolean leaves above false", { "profile.mix": { gt: false } }, ["b1"]],
    ["boolean leaves up to true", { "profile.mix": { lte: true } }, ["b1", "b2"]],
    ["nothing for an operand that is no JSON scalar", { "profile.mix": { gt: 5n } }, []],
    ["every other typed leaf under NOT, and never a NULL one", { NOT: { "profile.mix": { gt: 5 } } }, ["b1", "b2", "l", "n1", "n3", "o", "s1", "s2", "s3"]],
];

/** The structural slice of `findMany` the paging helper needs. */
type FindMany = (args: Record<string, unknown>) => Promise<{ continueCursor?: null | string; isDone: boolean; page: Record<string, unknown>[] }>;

/**
 * Page through every row, five at a time, ordering by the mixed-type path, and return the ids in the order the pages
 * came back. A keyset seek has to continue the `ORDER BY`, which sorts all the types together, so none may go missing.
 */
const pageAllMixed = async (findMany: FindMany, sort: "asc" | "desc"): Promise<string[]> => {
    const seen: string[] = [];
    let cursor: null | string | undefined;

    for (let guard = 0; guard < 10; guard += 1) {
        // eslint-disable-next-line no-await-in-loop -- each page needs the previous page's cursor
        const page = await findMany({ cursor, limit: 5, orderBy: [{ "profile.mix": sort }] });

        seen.push(...page.page.map((row) => String(row["_id"])));

        if (page.isDone) {
            return seen;
        }

        cursor = page.continueCursor;
    }

    throw new Error("paging did not terminate");
};

export { byId, MIX_QUERIES, MIX_ROWS, pageAllMixed };
