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
import { APIError, BASE_ERROR_CODES } from "@better-auth/core/error";
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

/** The address a hook's write leaves in place: the hook's own when it set the key (even to `undefined`), else the caller's. */
const writtenEmail = (replaced: Record<string, unknown> | undefined, data: Record<string, unknown>): unknown =>
    replaced !== undefined && "email" in replaced ? replaced["email"] : data["email"];

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
 *
 * A hook that sets `email` to `undefined` withholds the address from the write, so the
 * presence of the key decides, not its value: deriving from the caller's `email` then would
 * store a canonical value for an address that was never written.
 */
const withCanonicalData = (replaced: Record<string, unknown> | undefined, data: Record<string, unknown>): Record<string, unknown> => {
    const email = writtenEmail(replaced, data);

    return { ...replaced, [CANONICAL_EMAIL_FIELD]: typeof email === "string" ? canonicalEmail(email) : undefined };
};

type Where = { field: string; operator?: "gt" | "in"; value: string[] | string | null }[];

/**
 * The subset of better-auth's adapter the adapter-driven backfill and {@link canonicalHolders}
 * use, declared rather than imported for the reason {@link BackfillExecutor} gives.
 */
interface BackfillAdapter {
    count: (query: { model: string; where: Where }) => Promise<number>;
    findMany: <T>(query: { limit: number; model: string; sortBy?: { direction: "asc"; field: string }; where: Where }) => Promise<T[]>;
    findOne: <T>(query: { model: string; where: Where }) => Promise<T | null>;
    update: <T>(query: { model: string; update: Record<string, unknown>; where: Where }) => Promise<T | null>;
}

// eslint-disable-next-line unicorn/no-null -- better-auth compiles a `null` value to `IS NULL`
const UNFILLED: Where = [{ field: CANONICAL_EMAIL_FIELD, value: null }];

/**
 * Every account that holds `email` once case and Unicode form are ignored: the one whose
 * canonical value it is, and any whose canonical value is still empty (written before the
 * column and not yet backfilled, or a duplicate the backfill leaves) and whose address folds
 * to it. Those cannot be matched in SQL (`LOWER()` folds ASCII only, and nothing in SQLite
 * normalises Unicode form), so they are read and folded here, through the canonical index's
 * `IS NULL` range: a set the backfill only shrinks, so once a table is filled this is one
 * empty count.
 */
const canonicalHolders = async (adapter: BackfillAdapter, email: string): Promise<{ email?: unknown; id: string }[]> => {
    const canonical = canonicalEmail(email);
    const [held, unfilledCount] = await Promise.all([
        adapter.findMany<{ email?: unknown; id: string }>({ limit: 1, model: "user", where: [{ field: CANONICAL_EMAIL_FIELD, value: canonical }] }),
        adapter.count({ model: "user", where: UNFILLED }),
    ]);
    // An adapter's `findMany` defaults to a small limit, so the count sets it.
    const unfilled = unfilledCount > 0 ? await adapter.findMany<{ email?: unknown; id: string }>({ limit: unfilledCount, model: "user", where: UNFILLED }) : [];

    return [...held, ...unfilled.filter((row) => typeof row.email === "string" && canonicalEmail(row.email) === canonical)];
};

type HookContext = Parameters<UserCreateBefore>[1];

/**
 * Refuse a write whose address another account holds once case and Unicode form are ignored
 * ({@link canonicalHolders}, so a legacy row the backfill has not reached counts too), with the
 * error better-auth gives a plain duplicate. Its own check (`findUserByEmail`) matches the stored address, so a variant in
 * another case or Unicode form gets past it, and the unique index's refusal reaches the caller as
 * a server error. On a sign-up that answers duplicates generically (email verification required,
 * or no auto sign-in) the error is the `FORBIDDEN` the route turns into that generic answer.
 *
 * Needs an endpoint's adapter: a write outside one (the admin plane, which checks for itself) is
 * left to the index. A holder of the exact address is left to `email`'s own unique index too: it
 * is this same account rewriting its address unchanged as often as another one. `self` is the
 * account being written, from whichever of the session, a `userId` body field or path parameter
 * the route names; it may change its own address to another case. An update whose route names
 * none (an OAuth callback refreshing the profile, a sessionless email-change confirmation) is
 * not checked: its holder may be the account itself, so only the index can tell.
 */
const assertCanonicalFree = async (email: unknown, context: HookContext, self: ReadonlyArray<unknown>): Promise<void> => {
    // Absent, not only `null`, on a write made outside an endpoint.
    if (typeof email !== "string" || !context) {
        return;
    }

    const holders = await canonicalHolders(context.context.adapter, email);

    if (holders.every((holder) => holder.email === email || self.includes(holder.id))) {
        return;
    }

    const { emailAndPassword } = context.context.options;
    const generic = context.path === "/sign-up/email" && (emailAndPassword?.requireEmailVerification === true || emailAndPassword?.autoSignIn === false);

    throw APIError.from(generic ? "FORBIDDEN" : "UNPROCESSABLE_ENTITY", BASE_ERROR_CODES.USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL);
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

        if (result === false) {
            return false;
        }

        await assertCanonicalFree(writtenEmail(replacedData(result), user), context, []);

        return { data: withCanonicalData(replacedData(result), user) };
    };
    const updateBefore: UserUpdateBefore = async (patch, context) => {
        const result = await update?.before?.(patch, context);

        if (result === false) {
            return false;
        }

        const named = [context?.context.session?.user.id, (context?.body as { userId?: unknown } | undefined)?.userId, context?.params?.["userId"]].filter(
            (id) => id !== undefined,
        );

        if (named.length > 0) {
            await assertCanonicalFree(writtenEmail(replacedData(result), patch), context, named);
        }

        return { data: withCanonicalData(replacedData(result), patch) };
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

/** A backfill's statements, each answered with the rows it returns; the generator's result is the run's report. */
type BackfillSteps<R> = Generator<BackfillStep, R, Record<string, unknown>[]>;

/**
 * Where each backfill resumes, one row per physical table and column, written after every
 * page. A run cut short (D1's per-invocation query limit, an evicted isolate, a failed
 * statement) would otherwise start over at the first row, re-reading every row it must leave
 * as it is (a duplicate it cannot fill, an invitation already in canonical form) before it
 * reaches new ones. In the database itself, because the next run may be another isolate's.
 */
const BACKFILL_STATE_TABLE = "__lunora_auth_backfill__";

const readBackfillState = function* readBackfillState(name: string): BackfillSteps<unknown> {
    const table = quote(BACKFILL_STATE_TABLE);

    yield { params: [], sql: `CREATE TABLE IF NOT EXISTS ${table} ("name" TEXT NOT NULL PRIMARY KEY, "cursor" TEXT NOT NULL)` };

    const [row] = yield { params: [name], sql: `SELECT "cursor" FROM ${table} WHERE "name" = ?` };
    const cursor = row?.["cursor"];

    return typeof cursor === "string" ? (JSON.parse(cursor) as unknown) : undefined;
};

/** Record where the backfill's next run resumes; `undefined` starts it from the beginning. */
const writeBackfillState = function* writeBackfillState(name: string, cursor: unknown): BackfillSteps<void> {
    const table = quote(BACKFILL_STATE_TABLE);

    yield cursor === undefined
        ? { params: [name], sql: `DELETE FROM ${table} WHERE "name" = ?` }
        : {
              params: [name, JSON.stringify(cursor)],
              sql: `INSERT INTO ${table} ("name", "cursor") VALUES (?, ?) ON CONFLICT ("name") DO UPDATE SET "cursor" = excluded."cursor"`,
          };
};

/** A page's rows to fill as `[rowid, email, canonical]`: the first per canonical value, as two in one statement would both pass `NOT EXISTS`. */
const pageFills = (rows: Record<string, unknown>[]): Map<string, [unknown, string, string]> => {
    const fills = new Map<string, [unknown, string, string]>();

    for (const row of rows) {
        const { email } = row;

        if (typeof email === "string" && !fills.has(canonicalEmail(email))) {
            fills.set(canonicalEmail(email), [row["rid"], email, canonicalEmail(email)]);
        }
    }

    return fills;
};

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
 * they stay `NULL`, are counted, and are reported on every pass until resolved. `IS NULL`
 * is a range of the canonical column's own index, so a fully backfilled table costs one
 * empty read.
 *
 * Runs to the end of the table. Each page records the last row it read, so a run cut short
 * resumes after it; reaching the end clears that, so the next pass (a later cold start)
 * starts over and fills a duplicate the operator has since resolved.
 * @returns How many rows could not be filled because another row holds their canonical value.
 */
const backfillSteps = function* backfillSteps(column: CanonicalEmailColumn): BackfillSteps<number> {
    const table = quote(column.table);
    const canonical = quote(column.canonical);
    const email = quote(column.email);
    // Keyed on the physical names: another auth configuration's table in the same database has its own rowids.
    const state = `${column.table}.${column.canonical}`;
    const resumed = yield* readBackfillState(state);
    let after = typeof resumed === "number" ? resumed : 0;
    let duplicates = 0;

    for (;;) {
        const rows = yield {
            params: [after, BACKFILL_PAGE_ROWS],
            sql: `SELECT rowid AS "rid", ${email} AS "email" FROM ${table} WHERE ${canonical} IS NULL AND rowid > ? ORDER BY rowid LIMIT ?`,
        };
        const fills = pageFills(rows);

        duplicates += rows.filter((row) => typeof row["email"] === "string").length - fills.size;

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
            if (resumed !== undefined || after > 0) {
                yield* writeBackfillState(state, undefined);
            }

            return duplicates;
        }

        after = last;
        yield* writeBackfillState(state, after);
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
 * (D1), to the end of the table, resuming where a run cut short stopped.
 * @returns How many rows could not be filled because another row holds their canonical value.
 */
const backfillCanonicalEmails = async (executor: BackfillExecutor, column: CanonicalEmailColumn): Promise<number> => {
    const duplicates = await runBackfill(backfillSteps(column), executor);

    warnDuplicates(duplicates, column);

    return duplicates;
};

/**
 * The same backfill over a synchronous executor (a Durable Object's `storage.sql.exec`).
 * @returns How many rows could not be filled because another row holds their canonical value.
 */
const backfillCanonicalEmailsSync = (exec: (sql: string, params: unknown[]) => Record<string, unknown>[], column: CanonicalEmailColumn): number => {
    const duplicates = runBackfillSync(backfillSteps(column), exec);

    warnDuplicates(duplicates, column);

    return duplicates;
};

/**
 * Fill one row unless another holds `value`. A writer that claims it between the page's check
 * and this write fails it on the unique index: confirmed by reading the holder, that is a
 * duplicate like any other, not a reason to fail the migration.
 * @returns Whether the row now holds the value it was given.
 */
const fillThroughAdapter = async (adapter: BackfillAdapter, row: { email: string; id: string }, value: string): Promise<boolean> => {
    try {
        await adapter.update({
            model: "user",
            update: { [CANONICAL_EMAIL_FIELD]: value },
            where: [{ field: "id", value: row.id }, { field: "email", value: row.email }, ...UNFILLED],
        });

        return true;
    } catch (error) {
        if ((await adapter.findOne({ model: "user", where: [{ field: CANONICAL_EMAIL_FIELD, value }] })) !== null) {
            return false;
        }

        throw error;
    }
};

/**
 * The same backfill through better-auth's adapter, for a database the SQL above cannot
 * target (Postgres, MySQL, any other Kysely dialect): no `rowid`, no `UPDATE ... FROM
 * json_each`, so keyed on `id`, one write per row. A page costs one read of its rows, one
 * of the values already held, and its writes side by side. Runs to the end on every call;
 * filled rows leave the `IS NULL` range, so a run cut short loses only its last page. The
 * guards match the SQL's: a row is written only while it still holds the address read and
 * no canonical value, and skipped while another row holds its value.
 * @returns How many rows could not be filled because another row holds their canonical value.
 */
const backfillCanonicalEmailsThroughAdapter = async (adapter: BackfillAdapter): Promise<number> => {
    let after: string | undefined;
    let duplicates = 0;

    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- each page starts after the last one's final id
        const rows = await adapter.findMany<{ email?: unknown; id: string }>({
            limit: BACKFILL_PAGE_ROWS,
            model: "user",
            sortBy: { direction: "asc", field: "id" },
            where: [...UNFILLED, ...(after === undefined ? [] : [{ field: "id", operator: "gt" as const, value: after }])],
        });
        // The first row of the page per canonical value: two written side by side would both pass the check.
        const fills = new Map<string, { email: string; id: string }>();

        for (const row of rows) {
            if (typeof row.email === "string" && !fills.has(canonicalEmail(row.email))) {
                fills.set(canonicalEmail(row.email), { email: row.email, id: row.id });
            }
        }

        duplicates += rows.filter((row) => typeof row.email === "string").length - fills.size;

        const held =
            fills.size > 0
                ? // eslint-disable-next-line no-await-in-loop -- one read of the page's values
                  await adapter.findMany<Record<string, unknown>>({
                      limit: fills.size,
                      model: "user",
                      where: [{ field: CANONICAL_EMAIL_FIELD, operator: "in", value: [...fills.keys()] }],
                  })
                : [];

        for (const holder of held) {
            fills.delete(String(holder[CANONICAL_EMAIL_FIELD]));
            duplicates += 1;
        }

        // eslint-disable-next-line no-await-in-loop -- the page's writes run side by side; pages run in order
        const filled = await Promise.all([...fills].map(async ([value, row]) => fillThroughAdapter(adapter, row, value)));

        duplicates += filled.filter((written) => !written).length;

        const last = rows.at(-1);

        if (rows.length < BACKFILL_PAGE_ROWS || last === undefined) {
            return duplicates;
        }

        after = last.id;
    }
};

export type { BackfillAdapter, BackfillExecutor, BackfillStep, BackfillSteps, CanonicalEmailColumn };
export {
    authCanonicalEmailColumn,
    BACKFILL_PAGE_ROWS,
    BACKFILL_STATE_TABLE,
    backfillCanonicalEmails,
    backfillCanonicalEmailsSync,
    backfillCanonicalEmailsThroughAdapter,
    CANONICAL_EMAIL_FIELD,
    canonicalEmail,
    canonicalHolders,
    quote,
    readBackfillState,
    runBackfill,
    runBackfillSync,
    warnDuplicates,
    withCanonicalEmail,
    withCanonicalEmailValue,
    writeBackfillState,
};
