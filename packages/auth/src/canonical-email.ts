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
 */
const withCanonicalData = (replaced: Record<string, unknown> | undefined, data: Record<string, unknown>): Record<string, unknown> => {
    const email = replaced?.["email"] ?? data["email"];

    return typeof email === "string" ? { ...replaced, [CANONICAL_EMAIL_FIELD]: canonicalEmail(email) } : { ...replaced };
};

/**
 * `options` with the canonical column declared on `user` and filled on every create and
 * every update that sets `email`.
 *
 * Hooks rather than the adapter: they run for every adapter an app may pass, and every
 * user write better-auth makes goes through `internalAdapter`, which runs them. `input:
 * false` keeps it out of every request body and the admin create-user form; `returned:
 * false` keeps it out of the session user.
 */
const withCanonicalEmail = <O extends BetterAuthOptions>(options: O): O => {
    // `resolveAuthOptions` runs more than once on some paths (the auth DO resolves for its
    // schema, then `createAuth` resolves again); wrapping twice would run the hooks twice.
    if (options.user?.additionalFields?.[CANONICAL_EMAIL_FIELD] !== undefined) {
        return options;
    }

    const create = options.databaseHooks?.user?.create;
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
                [CANONICAL_EMAIL_FIELD]: { input: false, required: false, returned: false, type: "string", unique: true },
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

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * The two methods of `SqlExecutor` the backfill uses, declared here rather than imported:
 * `create-auth.ts` imports this module, and `sql-store.ts` would drag the store into every
 * consumer of its types.
 */
interface BackfillExecutor {
    all: (sql: string, parameters: ReadonlyArray<unknown>) => Promise<Record<string, unknown>[]>;
    run: (sql: string, parameters: ReadonlyArray<unknown>) => Promise<void>;
}

/** One statement the backfill needs run; the driver answers with the rows read, or the error a write raised. */
type BackfillStep = { params: unknown[]; read: boolean; sql: string };
/** `collided`: the write hit the unique index, which the backfill counts rather than fails on. */
type BackfillAnswer = { collided?: boolean; rows?: Record<string, unknown>[] };

const UNIQUE_VIOLATION = /UNIQUE constraint failed/u;

/** A write's error as an answer when it is a collision; anything else fails the backfill. */
const collision = (error: unknown): BackfillAnswer => {
    if (!UNIQUE_VIOLATION.test(error instanceof Error ? error.message : String(error))) {
        throw error;
    }

    return { collided: true };
};

/**
 * The backfill as a sequence of statements, so the synchronous Durable Object storage and
 * the asynchronous D1 binding run the same logic.
 *
 * In JS, a page at a time, because SQLite has no Unicode lowercasing to do it in one
 * `UPDATE`. A row whose canonical value another row already holds is left `NULL` and
 * counted: those are duplicates the old byte-exact index let in, and which account keeps
 * the address is the operator's call, not a migration's. They stay visible to this pass,
 * so it reports them on every run until resolved. `IS NULL` is a range of the canonical
 * column's own index, so a fully backfilled table costs one empty read.
 */
const backfillSteps = function* backfillSteps(column: CanonicalEmailColumn): Generator<BackfillStep, number, BackfillAnswer> {
    const table = quote(column.table);
    const canonical = quote(column.canonical);
    let after = 0;
    let duplicates = 0;

    for (;;) {
        const { rows = [] } = yield {
            params: [after, BACKFILL_PAGE_ROWS],
            read: true,
            sql: `SELECT rowid AS "rid", ${quote(column.email)} AS "email" FROM ${table} WHERE ${canonical} IS NULL AND rowid > ? ORDER BY rowid LIMIT ?`,
        };

        for (const row of rows) {
            if (typeof row["email"] === "string") {
                const { collided = false } = yield {
                    params: [canonicalEmail(row["email"]), row["rid"]],
                    read: false,
                    sql: `UPDATE ${table} SET ${canonical} = ? WHERE rowid = ?`,
                };

                duplicates += collided ? 1 : 0;
            }
        }

        const last = rows.at(-1)?.["rid"];

        if (rows.length < BACKFILL_PAGE_ROWS || typeof last !== "number") {
            return duplicates;
        }

        after = last;
    }
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

/**
 * Fill the canonical column for rows written before it existed, through an async executor (D1).
 * @returns How many rows could not be filled because another row holds their canonical value.
 */
const backfillCanonicalEmails = async (executor: BackfillExecutor, column: CanonicalEmailColumn): Promise<number> => {
    const steps = backfillSteps(column);
    let answer: BackfillAnswer = {};

    for (;;) {
        const step = steps.next(answer);

        if (step.done === true) {
            warnDuplicates(step.value, column);

            return step.value;
        }

        const { params, read, sql } = step.value;

        if (read) {
            // eslint-disable-next-line no-await-in-loop -- each statement depends on the last one's answer
            answer = { rows: await executor.all(sql, params) };
            continue;
        }

        try {
            // eslint-disable-next-line no-await-in-loop -- each statement depends on the last one's answer
            await executor.run(sql, params);
            answer = {};
        } catch (error) {
            answer = collision(error);
        }
    }
};

/**
 * The same backfill over a synchronous executor (a Durable Object's `storage.sql.exec`).
 * @returns How many rows could not be filled because another row holds their canonical value.
 */
const backfillCanonicalEmailsSync = (exec: (sql: string, params: unknown[]) => Record<string, unknown>[], column: CanonicalEmailColumn): number => {
    const steps = backfillSteps(column);
    let answer: BackfillAnswer = {};

    for (;;) {
        const step = steps.next(answer);

        if (step.done === true) {
            warnDuplicates(step.value, column);

            return step.value;
        }

        const { params, read, sql } = step.value;

        if (read) {
            answer = { rows: exec(sql, params) };
            continue;
        }

        try {
            exec(sql, params);
            answer = {};
        } catch (error) {
            answer = collision(error);
        }
    }
};

export type { CanonicalEmailColumn };
export {
    authCanonicalEmailColumn,
    backfillCanonicalEmails,
    backfillCanonicalEmailsSync,
    CANONICAL_EMAIL_FIELD,
    canonicalEmail,
    withCanonicalEmail,
    withCanonicalEmailValue,
};
