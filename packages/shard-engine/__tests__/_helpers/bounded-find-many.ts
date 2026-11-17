import { expect } from "vitest";

/**
 * The bounded (`endCursor`) `findMany` contract every store runs: the Durable Object store
 * (`@lunora/shard-engine`) and the `.global()` SQL store (`@lunora/sql-store`), each over
 * `node:sqlite` and over workerd. Runtime-neutral and import-free beyond vitest so every one of
 * those suites shares this copy.
 *
 * The open-ended walk is the reference: a bounded page `(cursor, endCursor]` must return exactly
 * the rows the walk put between those two cursors, under the same ordering.
 */

type Ordering = Record<string, "asc" | "desc">[];

interface BoundedPage {
    continueCursor: null | string;
    isDone: boolean;
    page: Record<string, unknown>[];
    splitCursor?: null | string;
}

/** One store's `findMany`/`insert`, already bound to the table under test. */
interface BoundedTarget {
    findMany: (args: { cursor?: null | string; endCursor?: null | string; limit?: number; orderBy?: Ordering }) => Promise<BoundedPage>;
    insert: (document: Record<string, unknown>) => Promise<unknown>;
}

/**
 * `[label, group, seq, score]`. `e`/`f` and `k`/`l` tie on `(group, seq)` so only the id splits
 * them; two NULL `score`s sort first ascending, so a range ending past them has NULL rows below a
 * non-null end pivot — the rows a `NOT (after end)` bound would drop.
 */
const ROWS: [string, string, number, null | number][] = [
    ["a", "x", 1, null],
    ["b", "y", 2, 10],
    ["c", "x", 3, 5],
    ["d", "y", 4, null],
    ["e", "x", 5, 7],
    ["f", "x", 5, 3],
    ["g", "y", 6, 7],
    ["h", "x", 7, 1],
    ["i", "y", 8, 9],
    ["j", "x", 9, 2],
    ["k", "y", 10, 8],
    ["l", "y", 10, 4],
];

const ORDERINGS: [string, Ordering][] = [
    ["seq asc", [{ seq: "asc" }]],
    ["seq desc", [{ seq: "desc" }]],
    ["group asc, seq desc (ties)", [{ group: "asc" }, { seq: "desc" }]],
    ["nullable score asc", [{ score: "asc" }]],
    ["nullable score desc", [{ score: "desc" }]],
];

const PAGE_SIZE = 3;

const labelsOf = (page: Record<string, unknown>[]): string[] => page.map((row) => String(row["label"]));

const seed = async (target: BoundedTarget): Promise<void> => {
    for (const [label, group, seq, score] of ROWS) {
        // eslint-disable-next-line no-await-in-loop -- sequential inserts keep the fixture deterministic
        await target.insert(score === null ? { group, label, seq } : { group, label, score, seq });
    }
};

/** Walk the open-ended pages; `cursors[i]` is the `continueCursor` that ended page `i`. */
const walk = async (target: BoundedTarget, orderBy: Ordering, size: number): Promise<{ cursors: string[]; pages: string[][] }> => {
    const pages: string[][] = [];
    const cursors: string[] = [];
    let cursor: null | string | undefined;

    for (let guard = 0; guard <= ROWS.length + 2; guard += 1) {
        // eslint-disable-next-line no-await-in-loop -- each page needs the previous page's cursor
        const result = await target.findMany({ cursor, limit: size, orderBy });

        pages.push(labelsOf(result.page));

        if (result.isDone || result.continueCursor === null) {
            return { cursors, pages };
        }

        cursors.push(result.continueCursor);
        cursor = result.continueCursor;
    }

    throw new Error("pagination did not terminate");
};

/** Builds a fresh, empty store for one case; `name` is unique per case, for a store whose tables outlive it. */
type OpenTarget = (name: string) => Promise<BoundedTarget>;

/** One case of the contract: a title, and a body that opens its own store. */
type BoundedCase = readonly [title: string, run: (open: OpenTarget) => Promise<void>];

const rangeCase = ([name, orderBy]: [string, Ordering]): BoundedCase => [
    `returns exactly the rows the open-ended walk put in each range under ${name}`,
    async (open: OpenTarget): Promise<void> => {
        expect.assertions(8);

        const target = await open(`bounded_${name.replaceAll(/\W+/gu, "_")}`);

        await seed(target);

        const { cursors, pages } = await walk(target, orderBy, PAGE_SIZE);

        expect(cursors).toHaveLength(3);

        for (const [index, endCursor] of cursors.entries()) {
            // eslint-disable-next-line no-await-in-loop -- one range at a time
            const bounded = await target.findMany({ cursor: cursors[index - 1], endCursor, orderBy });

            expect(labelsOf(bounded.page)).toStrictEqual(pages[index]);
            expect(bounded).toMatchObject({ continueCursor: endCursor, isDone: true });
        }

        // From the start: every NULL row before a non-null end pivot belongs to the range.
        const fromStart = await target.findMany({ endCursor: cursors.at(-1), orderBy });

        expect(labelsOf(fromStart.page)).toStrictEqual(pages.slice(0, cursors.length).flat());
    },
];

/** The bounded (`endCursor`) `findMany` contract; run each with `it.each(BOUNDED_FIND_MANY_CASES)`. */
const BOUNDED_FIND_MANY_CASES: ReadonlyArray<BoundedCase> = [
    ...ORDERINGS.map((ordering) => rangeCase(ordering)),
    [
        "grows when a row is inserted inside the range, and leaves the next page unchanged",
        async (open: OpenTarget): Promise<void> => {
            expect.assertions(4);

            const target = await open("bounded_insert");
            const orderBy: Ordering = [{ seq: "asc" }];

            await seed(target);

            const { cursors, pages } = await walk(target, orderBy, PAGE_SIZE);
            const [c0, c1, c2] = cursors;
            const nextBefore = await target.findMany({ cursor: c1, endCursor: c2, orderBy });

            // seq 4.5 sorts between `d` (4) and `e`/`f` (5): inside the second page.
            await target.insert({ group: "x", label: "inserted", seq: 4.5 });

            const grown = await target.findMany({ cursor: c0, endCursor: c1, orderBy });
            const nextAfter = await target.findMany({ cursor: c1, endCursor: c2, orderBy });
            const openNext = await target.findMany({ cursor: c1, limit: PAGE_SIZE, orderBy });

            expect(labelsOf(grown.page)).toStrictEqual(["d", "inserted", ...(pages[1] ?? []).slice(1)]);
            expect(labelsOf(nextAfter.page)).toStrictEqual(labelsOf(nextBefore.page));
            expect(labelsOf(nextAfter.page)).toStrictEqual(pages[2]);
            expect(labelsOf(openNext.page)).toStrictEqual(pages[2]);
        },
    ],
    [
        "names the midpoint as splitCursor, and the two halves reproduce the range",
        async (open: OpenTarget): Promise<void> => {
            expect.assertions(6);

            const target = await open("bounded_split");
            const orderBy: Ordering = [{ group: "asc" }, { seq: "desc" }];

            await seed(target);

            const { cursors, pages } = await walk(target, orderBy, PAGE_SIZE);
            const endCursor = cursors[2];
            const range = await target.findMany({ endCursor, orderBy });
            const expected = pages.slice(0, 3).flat();

            expect(labelsOf(range.page)).toStrictEqual(expected);
            expect(typeof range.splitCursor).toBe("string");

            const lower = await target.findMany({ endCursor: range.splitCursor, orderBy });
            const upper = await target.findMany({ cursor: range.splitCursor, endCursor, orderBy });

            // `page[floor(n / 2) - 1]` is the last row of the lower half, as `query().paginate()` splits.
            expect(labelsOf(lower.page)).toStrictEqual(expected.slice(0, Math.floor(expected.length / 2)));
            expect([...labelsOf(lower.page), ...labelsOf(upper.page)]).toStrictEqual(expected);

            // Under two rows there is no midpoint to split at; an open-ended page carries no splitCursor at all.
            const single = await walk(target, orderBy, 1);
            const oneRow = await target.findMany({ cursor: single.cursors[0], endCursor: single.cursors[1], orderBy });

            expect(oneRow.splitCursor).toBeNull();
            await expect(target.findMany({ limit: PAGE_SIZE, orderBy })).resolves.not.toHaveProperty("splitCursor");
        },
    ],
    [
        "caps a bounded read at limit, says so with splitRequired, and the half past splitCursor recovers the rows the cap held back",
        async (open: OpenTarget): Promise<void> => {
            expect.assertions(6);

            const target = await open("bounded_limit");
            const orderBy: Ordering = [{ seq: "asc" }];

            await seed(target);

            const { cursors, pages } = await walk(target, orderBy, PAGE_SIZE);
            const endCursor = cursors[2];
            const expected = pages.slice(0, 3).flat();
            const capped = await target.findMany({ endCursor, limit: 4, orderBy });

            expect(labelsOf(capped.page)).toStrictEqual(expected.slice(0, 4));
            // Cut short, so the client must split it even though 4 rows is within twice a page of 3.
            expect(capped).toMatchObject({ continueCursor: endCursor, isDone: true, splitRequired: true });
            // A limit the range fits in cuts nothing.
            await expect(target.findMany({ endCursor, limit: expected.length, orderBy })).resolves.not.toHaveProperty("splitRequired");

            const rest = await target.findMany({ cursor: capped.splitCursor, endCursor, orderBy });

            // The midpoint of the 4 rows returned is the 2nd; everything after it comes back.
            expect(labelsOf(rest.page)).toStrictEqual(expected.slice(2));

            // A cut page that kept one row splits right after it, so the rest is still reachable.
            const one = await target.findMany({ endCursor, limit: 1, orderBy });
            const afterOne = await target.findMany({ cursor: one.splitCursor, endCursor, orderBy });

            expect(labelsOf(afterOne.page)).toStrictEqual(expected.slice(1));

            const empty = await target.findMany({ endCursor, limit: 0, orderBy });

            expect(empty).toMatchObject({ continueCursor: endCursor, isDone: true, page: [], splitCursor: null });
        },
    ],
    [
        "refuses a malformed endCursor like a malformed cursor",
        async (open: OpenTarget): Promise<void> => {
            expect.assertions(6);

            const target = await open("bounded_malformed");
            const orderBy: Ordering = [{ seq: "asc" }];

            await seed(target);

            await expect(target.findMany({ cursor: "not-a-cursor", orderBy })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
            await expect(target.findMany({ endCursor: "not-a-cursor", orderBy })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
            // An empty string is a malformed cursor, not an absent one.
            await expect(target.findMany({ endCursor: "", orderBy })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
            await expect(target.findMany({ endCursor: "not-a-cursor", limit: 2, orderBy })).rejects.toMatchObject({ code: "INVALID_CURSOR" });

            // The lower cursor is held to the same rule: empty is malformed, not "from the start".
            const { cursors } = await walk(target, orderBy, PAGE_SIZE);

            await expect(target.findMany({ cursor: "", endCursor: cursors[1], orderBy })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
            await expect(target.findMany({ cursor: "", limit: 2, orderBy })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
        },
    ],
];

export type { BoundedTarget, OpenTarget };
export { BOUNDED_FIND_MANY_CASES };
