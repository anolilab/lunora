/**
 * The canonical form of `user.email`, stored in its own uniquely indexed column.
 *
 * `user.email` keeps the address as written, and its unique index compares bytes. A
 * case-insensitive lookup on it cannot be made both correct and cheap on SQLite:
 * `LOWER()` folds ASCII only, so `ÉLISE@x` and `élise@x` both pass a uniqueness
 * check that relies on it, and a `LOWER(email) = LOWER(?)` predicate cannot use the
 * index, so every lookup scans the table. Folding once in JS on write, into a column
 * of its own, gives the unique index the full Unicode comparison and turns the lookup
 * into an exact match.
 *
 * Declared as a `user` field on the resolved options rather than created by hand, so
 * every path that derives the schema from better-auth sees it: the Durable Object DDL,
 * better-auth's kysely migrator, `authTables(...)`, and the schema check.
 */
import type { BetterAuthOptions } from "better-auth";
import { getAuthTables } from "better-auth/db";

/** The logical (and, unless an app renames it, physical) name of the column. */
const CANONICAL_EMAIL_FIELD = "emailCanonical";

/**
 * Two addresses are the same account when this returns the same string. NFC first, so
 * a precomposed `é` and `e` + combining acute fold together, then full Unicode
 * lowercasing, which SQLite's `LOWER()` does not do.
 */
const canonicalEmail = (email: string): string => email.trim().normalize("NFC").toLowerCase();

type DatabaseHooks = NonNullable<BetterAuthOptions["databaseHooks"]>;
type UserHooks = NonNullable<DatabaseHooks["user"]>;
type UserCreateBefore = NonNullable<NonNullable<UserHooks["create"]>["before"]>;
type UserUpdateBefore = NonNullable<NonNullable<UserHooks["update"]>["before"]>;

/** The fields a hook's `{ data }` result replaces, merged as better-auth merges it. `| null`: a plain-JS hook can return one. */
const replacedData = (result: unknown): Record<string, unknown> | undefined =>
    typeof result === "object" && result !== null && "data" in result ? (result as { data: Record<string, unknown> }).data : undefined;

/**
 * The data a `before` hook hands back once the caller's own hook has run over `data` and
 * replaced `replaced`: theirs, plus the canonical value of the address it leaves in place.
 * After, not before: a caller's hook that rewrites `email` would otherwise persist an
 * address its canonical value no longer describes.
 *
 * A write that sets no address gets the field as `undefined`, which better-auth's adapter
 * layer leaves out of the `UPDATE`. better-auth merges a hook's data over the caller's, so
 * dropping the key from ours would not drop it from theirs, and any `updateUser` caller
 * could otherwise point a user at another account's canonical address or clear its own.
 */
const withCanonicalData = (replaced: Record<string, unknown> | undefined, data: Record<string, unknown>): Record<string, unknown> => {
    const email = replaced?.["email"] ?? data["email"];

    return { ...replaced, [CANONICAL_EMAIL_FIELD]: typeof email === "string" ? canonicalEmail(email) : undefined };
};

/**
 * The `create.before` hooks this module installed. `resolveAuthOptions` runs more than once
 * on some paths (the auth DO resolves for its schema, then `createAuth` resolves again), and
 * the field's presence cannot say whether the hooks are in: an app may declare it itself.
 */
const installedHooks = new WeakSet<UserCreateBefore>();

/**
 * `options` with the canonical column declared on `user` and filled on every create and
 * every update that sets `email`.
 *
 * Hooks rather than the adapter: they run for every adapter an app may pass, and every
 * user write better-auth makes goes through `internalAdapter`, which runs them. `input:
 * false` keeps it out of every request body and the admin create-user form; `returned:
 * false` keeps it out of the session user. An app's own declaration of the field keeps
 * its `fieldName`; the attributes the column depends on are forced over it.
 */
const withCanonicalEmail = <O extends BetterAuthOptions>(options: O): O => {
    const create = options.databaseHooks?.user?.create;

    if (create?.before !== undefined && installedHooks.has(create.before)) {
        return options;
    }

    const update = options.databaseHooks?.user?.update;
    // `false` is the caller's veto, and stays one.
    const createBefore: UserCreateBefore = async (user, context) => {
        const result = await create?.before?.(user, context);

        return result === false ? false : { data: withCanonicalData(replacedData(result), user) };
    };
    const updateBefore: UserUpdateBefore = async (patch, context) => {
        const result = await update?.before?.(patch, context);

        return result === false ? false : { data: withCanonicalData(replacedData(result), patch) };
    };

    installedHooks.add(createBefore);

    return {
        ...options,
        databaseHooks: {
            ...options.databaseHooks,
            user: {
                ...options.databaseHooks?.user,
                create: { ...create, before: createBefore },
                update: { ...update, before: updateBefore },
            },
        },
        user: {
            ...options.user,
            additionalFields: {
                ...options.user?.additionalFields,
                [CANONICAL_EMAIL_FIELD]: {
                    ...options.user?.additionalFields?.[CANONICAL_EMAIL_FIELD],
                    input: false,
                    required: false,
                    returned: false,
                    type: "string",
                    unique: true,
                },
            },
        },
    };
};

/** Where the canonical value lives physically, and the address column it is derived from. */
interface CanonicalEmailColumn {
    canonical: string;
    email: string;
    table: string;
}

/**
 * The physical names for {@link CanonicalEmailColumn}, read off better-auth's resolved
 * tables so a renamed `user` model or `email` field is followed.
 * @param options Resolved auth options — ones that went through `resolveAuthOptions`.
 */
const authCanonicalEmailColumn = (options: BetterAuthOptions): CanonicalEmailColumn | undefined => {
    const { user } = getAuthTables(options);
    const canonical = user?.fields[CANONICAL_EMAIL_FIELD];

    if (user === undefined || canonical === undefined) {
        return undefined;
    }

    return { canonical: canonical.fieldName ?? CANONICAL_EMAIL_FIELD, email: user.fields["email"]?.fieldName ?? "email", table: user.modelName };
};

/**
 * `row` with the canonical column recomputed from its address. A value the row already
 * carries is never trusted: an import is caller-supplied, and a stale or forged value
 * would let a duplicate through the index.
 */
const withCanonicalEmailValue = (row: Record<string, unknown>, table: string, column: CanonicalEmailColumn | undefined): Record<string, unknown> => {
    if (column?.table !== table) {
        return row;
    }

    const rest = Object.fromEntries(Object.entries(row).filter(([name]) => name !== column.canonical));
    const email = row[column.email];

    return typeof email === "string" ? { ...rest, [column.canonical]: canonicalEmail(email) } : rest;
};

const BACKFILL_PAGE_ROWS = 200;

/**
 * Pages one async run fills at most: two D1 queries a page, well inside the per-invocation
 * query budget the first request's `ensureMigrated` shares with the request itself. A
 * larger table fills over later runs; until then `assertEmailFree` covers its unfilled rows.
 */
const BACKFILL_MAX_PAGES = 20;

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * The method of `SqlExecutor` the backfill uses, declared here rather than imported:
 * `create-auth.ts` imports this module, and `sql-store.ts` would drag the store into every
 * consumer of its types.
 */
interface BackfillExecutor {
    all: (sql: string, parameters: ReadonlyArray<unknown>) => Promise<Record<string, unknown>[]>;
}

/** One statement the backfill needs run, answered with the rows it returns. */
type BackfillStep = { params: unknown[]; sql: string };

/**
 * The backfill as a sequence of statements, so the synchronous Durable Object storage and
 * the asynchronous D1 binding run the same logic.
 *
 * In JS, a page at a time, because SQLite has no Unicode lowercasing to do it in one
 * `UPDATE`. Each page is one `UPDATE ... FROM json_each(?)`, so its cost does not grow with
 * the page. A row is written only while it still holds the address that was read and has no
 * canonical value yet, so a concurrent email change is never overwritten with the old
 * address's value; and only while no other row holds that value, so a collision skips the
 * row instead of failing the statement. Those rows are duplicates the old byte-exact index
 * let in, and which account keeps the address is the operator's call, not a migration's:
 * they stay `NULL`, are counted, and are reported on every run until resolved. `IS NULL`
 * is a range of the canonical column's own index, so a fully backfilled table costs one
 * empty read.
 */
const backfillSteps = function* backfillSteps(column: CanonicalEmailColumn, maxPages: number): Generator<BackfillStep, number, Record<string, unknown>[]> {
    const table = quote(column.table);
    const canonical = quote(column.canonical);
    const email = quote(column.email);
    let after = 0;
    let duplicates = 0;

    for (let page = 0; page < maxPages; page += 1) {
        const rows = yield {
            params: [after, BACKFILL_PAGE_ROWS],
            sql: `SELECT rowid AS "rid", ${email} AS "email" FROM ${table} WHERE ${canonical} IS NULL AND rowid > ? ORDER BY rowid LIMIT ?`,
        };
        // The first row of the page per canonical value: two in one statement would both pass `NOT EXISTS`.
        const fills = new Map<string, [unknown, string, string]>();

        for (const row of rows) {
            if (typeof row["email"] === "string") {
                const value = canonicalEmail(row["email"]);

                if (fills.has(value)) {
                    duplicates += 1;
                } else {
                    fills.set(value, [row["rid"], row["email"], value]);
                }
            }
        }

        if (fills.size > 0) {
            const filled = yield {
                params: [JSON.stringify([...fills.values()])],
                sql:
                    `UPDATE ${table} SET ${canonical} = "v"."canonical" ` +
                    `FROM (SELECT json_extract("value", '$[0]') AS "rid", json_extract("value", '$[1]') AS "email", json_extract("value", '$[2]') AS "canonical" FROM json_each(?)) AS "v" ` +
                    `WHERE ${table}.rowid = "v"."rid" AND ${table}.${email} = "v"."email" AND ${table}.${canonical} IS NULL ` +
                    `AND NOT EXISTS (SELECT 1 FROM ${table} AS "held" WHERE "held".${canonical} = "v"."canonical") RETURNING rowid`,
            };

            duplicates += fills.size - filled.length;
        }

        const last = rows.at(-1)?.["rid"];

        if (rows.length < BACKFILL_PAGE_ROWS || typeof last !== "number") {
            break;
        }

        after = last;
    }

    return duplicates;
};

const warnDuplicates = (duplicates: number, column: CanonicalEmailColumn): void => {
    if (duplicates > 0) {
        // eslint-disable-next-line no-console -- no injected logger at the migration layer (workerd/Node both capture console)
        console.warn(
            `@lunora/auth: ${String(duplicates)} user row(s) share an address with another account once case and Unicode form are ignored, ` +
                `so their "${column.canonical}" stays empty and they are not protected against a further duplicate. Merge or rename them.`,
        );
    }
};

/** A backfill's statements, each answered with the rows it returns; the generator's result is the run's report. */
type BackfillSteps<R> = Generator<BackfillStep, R, Record<string, unknown>[]>;

/** Run `steps` through an async executor (D1). */
const runBackfill = async <R>(steps: BackfillSteps<R>, executor: BackfillExecutor): Promise<R> => {
    let answer: Record<string, unknown>[] = [];

    for (;;) {
        const step = steps.next(answer);

        if (step.done === true) {
            return step.value;
        }

        // eslint-disable-next-line no-await-in-loop -- each statement depends on the last one's answer
        answer = await executor.all(step.value.sql, step.value.params);
    }
};

/** Run `steps` through a synchronous executor (a Durable Object's `storage.sql.exec`). */
const runBackfillSync = <R>(steps: BackfillSteps<R>, exec: (sql: string, params: unknown[]) => Record<string, unknown>[]): R => {
    let answer: Record<string, unknown>[] = [];

    for (;;) {
        const step = steps.next(answer);

        if (step.done === true) {
            return step.value;
        }

        answer = exec(step.value.sql, step.value.params);
    }
};

/**
 * Fill the canonical column for rows written before it existed, through an async executor
 * (D1), at most {@link BACKFILL_MAX_PAGES} pages per call.
 * @returns How many rows read could not be filled, because another row holds their canonical value.
 */
const backfillCanonicalEmails = async (executor: BackfillExecutor, column: CanonicalEmailColumn): Promise<number> => {
    const duplicates = await runBackfill(backfillSteps(column, BACKFILL_MAX_PAGES), executor);

    warnDuplicates(duplicates, column);

    return duplicates;
};

/**
 * The same backfill over a synchronous executor (a Durable Object's `storage.sql.exec`),
 * to the end of the table: local SQLite has no per-invocation query budget.
 * @returns How many rows could not be filled because another row holds their canonical value.
 */
const backfillCanonicalEmailsSync = (exec: (sql: string, params: unknown[]) => Record<string, unknown>[], column: CanonicalEmailColumn): number => {
    const duplicates = runBackfillSync(backfillSteps(column, Number.POSITIVE_INFINITY), exec);

    warnDuplicates(duplicates, column);

    return duplicates;
};

export type { BackfillExecutor, BackfillStep, BackfillSteps, CanonicalEmailColumn };
export {
    authCanonicalEmailColumn,
    BACKFILL_MAX_PAGES,
    BACKFILL_PAGE_ROWS,
    backfillCanonicalEmails,
    backfillCanonicalEmailsSync,
    CANONICAL_EMAIL_FIELD,
    canonicalEmail,
    quote,
    runBackfill,
    runBackfillSync,
    withCanonicalEmail,
    withCanonicalEmailValue,
};
