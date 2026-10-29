/**
 * The one dataset every store runs the many-to-many reads against: the Durable Object store on `node:sqlite`
 * (`@lunora/shard-engine`), a Durable Object on workerd (`@lunora/do`), and the D1 column store (`@lunora/d1`). The
 * results in {@link THROUGH_CASES} are the contract: `with`, `_count` and the `some`/`every`/`none` predicates over
 * `posts.tags` (through `post_tags`) must return exactly these rows on every backend.
 *
 * The seed is chosen to hit the edges: a post with no links, a link to a tag that no longer exists, and a tag no post
 * uses.
 */

/** The structural slice of a writer the cases need. */
interface ThroughWriter {
    findMany: (tableName: string, args?: Record<string, unknown>) => Promise<{ page: Record<string, unknown>[] }>;
    insert: (tableName: string, document: Record<string, unknown>, options?: { allowExplicitId?: boolean }) => Promise<unknown>;
}

const column = (kind: string): { _meta: { column: { notNull: boolean } }; kind: string } => {
    return { _meta: { column: { notNull: true } }, kind };
};

const idColumn = (tableName: string): { _meta: { column: { notNull: boolean }; tableName: string }; kind: string } => {
    return { _meta: { column: { notNull: true }, tableName }, kind: "id" };
};

/** A `SchemaLike`, kept structural so the three packages can each type it against their own. */
const THROUGH_SCHEMA = {
    tables: {
        post_tags: {
            indexes: [{ fields: ["postId", "tagId"], name: "byPair", unique: true }],
            relationMap: {
                post: { field: "postId", kind: "one", onDelete: "cascade", references: "_id", table: "posts" },
                tag: { field: "tagId", kind: "one", onDelete: "cascade", references: "_id", table: "tags" },
            },
            shape: { postId: idColumn("posts"), tagId: idColumn("tags") },
        },
        posts: {
            indexes: [],
            relationMap: { tags: { kind: "many", table: "tags", through: { from: "postId", table: "post_tags", to: "tagId" } } },
            shape: { title: column("string") },
        },
        tags: { indexes: [], shape: { label: column("string") } },
    },
} as const;

/** `[table, rows]` in insertion order. `post_tags` is last so a cascade has nothing to remove while seeding. */
const SEED: [string, Record<string, unknown>[]][] = [
    [
        "posts",
        [
            { _id: "p1", title: "alpha" },
            { _id: "p2", title: "beta" },
            { _id: "p3", title: "gamma" },
        ],
    ],
    [
        "tags",
        [
            { _id: "t1", label: "red" },
            { _id: "t2", label: "green" },
            { _id: "t3", label: "blue" },
            { _id: "t4", label: "unused" },
        ],
    ],
    [
        "post_tags",
        [
            { _id: "l1", postId: "p1", tagId: "t1" },
            { _id: "l2", postId: "p1", tagId: "t2" },
            { _id: "l3", postId: "p2", tagId: "t2" },
            { _id: "l4", postId: "p2", tagId: "t3" },
            // A link to a tag that was deleted without its join row: it counts for nothing.
            { _id: "l5", postId: "p1", tagId: "gone" },
        ],
    ],
];

const seedThrough = async (writer: ThroughWriter): Promise<void> => {
    for (const [tableName, rows] of SEED) {
        for (const row of rows) {
            // eslint-disable-next-line no-await-in-loop -- insertion order matters to nothing here, but a seed reads best sequential
            await writer.insert(tableName, row, { allowExplicitId: true });
        }
    }
};

/** Ids of the posts a `where` selects, sorted. */
const postIds = async (writer: ThroughWriter, where: Record<string, unknown>): Promise<string[]> => {
    const { page } = await writer.findMany("posts", { where });

    return page.map((row) => String(row["_id"])).toSorted((left, right) => left.localeCompare(right));
};

/** Every post with its tags loaded, as `{ postId: [tagLabels...] }`, so a case reads at a glance. */
const tagLabels = async (
    writer: ThroughWriter,
    tags: Record<string, unknown> | true,
    extra: Record<string, unknown> = {},
): Promise<Record<string, string[]>> => {
    const { page } = await writer.findMany("posts", { orderBy: [{ _id: "asc" }], with: { tags }, ...extra });

    return Object.fromEntries(page.map((row) => [String(row["_id"]), (row["tags"] as Record<string, unknown>[]).map((tag) => String(tag["label"]))]));
};

interface ThroughCase {
    expected: unknown;
    name: string;
    run: (writer: ThroughWriter) => Promise<unknown>;
}

const THROUGH_CASES: ThroughCase[] = [
    {
        expected: { p1: ["green", "red"], p2: ["blue", "green"], p3: [] },
        name: "with loads each post's tags in the target's order, and none for an unlinked post",
        run: (writer) => tagLabels(writer, { orderBy: [{ label: "asc" }] }),
    },
    {
        expected: { p1: ["red"], p2: [], p3: [] },
        name: "with applies the nested where to the tags",
        run: (writer) => tagLabels(writer, { where: { label: "red" } }),
    },
    {
        expected: { p1: ["green"], p2: ["blue"], p3: [] },
        name: "with caps each post's tags with limit",
        run: (writer) => tagLabels(writer, { limit: 1, orderBy: [{ label: "asc" }] }),
    },
    {
        expected: { p1: 2, p2: 2, p3: 0 },
        name: "_count counts linked tags that exist, not join rows",
        run: async (writer: ThroughWriter): Promise<unknown> => {
            const { page } = await writer.findMany("posts", { orderBy: [{ _id: "asc" }], with: { _count: { tags: true } } });

            return Object.fromEntries(page.map((row) => [String(row["_id"]), (row["_count"] as Record<string, number>)["tags"]]));
        },
    },
    {
        expected: ["p1", "p2"],
        name: "some matches a post with at least one matching tag",
        run: (writer) => postIds(writer, { tags: { some: { label: "green" } } }),
    },
    {
        expected: ["p1", "p2"],
        name: "some with an empty predicate matches every post that has a tag",
        run: (writer) => postIds(writer, { tags: { some: {} } }),
    },
    {
        expected: ["p2", "p3"],
        name: "none matches a post with no matching tag, and one with no tags",
        run: (writer) => postIds(writer, { tags: { none: { label: "red" } } }),
    },
    {
        expected: ["p3"],
        name: "every is vacuously true for an unlinked post and false for one with any other tag",
        run: (writer) => postIds(writer, { tags: { every: { label: "green" } } }),
    },
    {
        expected: ["p1", "p2", "p3"],
        name: "every matches when all of a post's tags satisfy the predicate",
        run: (writer) => postIds(writer, { tags: { every: { label: { in: ["red", "green", "blue"] } } } }),
    },
    {
        expected: ["p2"],
        name: "a through predicate composes with the post's own columns",
        run: (writer) => postIds(writer, { tags: { some: { label: "green" } }, title: "beta" }),
    },
    {
        expected: ["p1"],
        name: "two predicates on one relation both have to hold",
        run: (writer) => postIds(writer, { tags: { none: { label: "blue" }, some: { label: "red" } } }),
    },
];

/** How many tags the wide post links: past the 100 bound parameters workerd allows a statement, so no list may expand to one per id. */
const WIDE_LINKS = 150;

/** One more post linked to {@link WIDE_LINKS} tags, so each hop of a predicate carries a list wider than 100. */
const seedWide = async (writer: ThroughWriter): Promise<void> => {
    await writer.insert("posts", { _id: "wide", title: "wide" }, { allowExplicitId: true });

    for (let index = 0; index < WIDE_LINKS; index += 1) {
        const tag = `w${String(index).padStart(3, "0")}`;

        // eslint-disable-next-line no-await-in-loop -- sequential seed
        await writer.insert("tags", { _id: tag, label: `wide-${tag}` }, { allowExplicitId: true });
        // eslint-disable-next-line no-await-in-loop -- sequential seed
        await writer.insert("post_tags", { postId: "wide", tagId: tag }, { allowExplicitId: true });
    }
};

/** Cases over the wide post, run after {@link seedWide}; the tags a predicate matches number {@link WIDE_LINKS} at the first hop and the post matches at the second. */
const WIDE_CASES: ThroughCase[] = [
    {
        expected: ["wide"],
        name: "some over a 150-tag first hop",
        run: (writer) => postIds(writer, { tags: { some: { label: { contains: "wide-" } } } }),
    },
    {
        expected: ["p1", "p2", "p3"],
        name: "none over a 150-tag first hop",
        run: (writer) => postIds(writer, { tags: { none: { label: { contains: "wide-" } } } }),
    },
    {
        expected: ["p3", "wide"],
        name: "every over a 150-tag first hop: the post fully inside the set matches, and so does the unlinked one",
        run: (writer) => postIds(writer, { tags: { every: { label: { contains: "wide-" } } } }),
    },
    {
        expected: { wide: WIDE_LINKS },
        name: "with loads 150 linked tags in one batch",
        run: async (writer: ThroughWriter): Promise<unknown> => {
            const { page } = await writer.findMany("posts", { where: { title: "wide" }, with: { tags: true } });

            return Object.fromEntries(page.map((row) => [String(row["_id"]), (row["tags"] as unknown[]).length]));
        },
    },
];

export type { ThroughCase, ThroughWriter };
export { seedThrough, seedWide, THROUGH_CASES, THROUGH_SCHEMA, WIDE_CASES, WIDE_LINKS };
