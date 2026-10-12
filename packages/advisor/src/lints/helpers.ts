import { sanitizeNamespace } from "../../../../shared/dispatch-namespace";
import type { AdvisorCallEdge } from "../call-edges";
import type { AdvisorCallSiteScope, CallSiteMetadata } from "../call-site-scope";
import { callSiteCallers, callSiteMetadata, helperRole } from "../call-site-scope";
import type { AdvisorTableWrite } from "../inserts";
import type { AdvisorProcedureProtection } from "../procedure-protections";
import type { AdvisorQueryRead } from "../queries";
import type { AdvisorRowEffect } from "../row-effects";
import type { AdvisorSchema, AdvisorTable } from "../schema";

/** A feeder row that names a call site: its scope and where it sits. */
interface CallSiteRow {
    file: string;
    line: number;
    scope: AdvisorCallSiteScope;
}

/**
 * Writes that can take a row out of, or move it within, the range a read selects.
 * `patch` is included although only some patches move a row out of a range: the
 * lint cannot read which field a patch sets, so a patch counts as progress. A sweep
 * that patches a field the range does not depend on is therefore not reported.
 */
const ROW_CHANGING_WRITES: ReadonlySet<string> = new Set(["delete", "deleteMany", "hardDelete", "patch", "patchIf", "patchMany", "patchWhere", "replace"]);

/**
 * Whether one change can take a row out of the range a read selects. A delete or
 * replace can always do that. A patch does only when it writes an index field. With
 * no index, or fields the feeder could not read, any change counts.
 */
const changeTouches = (change: RowChange, indexFields: ReadonlyArray<string> | undefined): boolean => {
    if (change.method !== "patch" && change.method !== "patchMany") {
        return true;
    }

    if (indexFields === undefined || change.fields === undefined) {
        return true;
    }

    return change.fields.some((field) => indexFields.includes(field));
};

/**
 * Personally-identifiable-information column names. Kept deliberately tight to
 * unambiguous PII field names — not broad "sounds personal" guesses — to hold
 * the false-positive rate down. Matched through {@link isPiiColumn}, never by
 * bare set membership: the spelling a schema actually uses (`emailAddress`,
 * `home_phone`) is rarely the canonical entry.
 */
const PII_FIELD_NAME_LIST = [
    "address",
    "birthdate",
    "creditCard",
    "dateOfBirth",
    "dob",
    "driversLicense",
    "email",
    "firstName",
    "fullName",
    "lastName",
    "nationalId",
    "passport",
    "phone",
    "phoneNumber",
    "socialSecurity",
    "socialSecurityNumber",
    "ssn",
    "taxId",
] as const;

/** Every character a column name can be spelled with that carries no meaning for matching. */
const NON_ALPHANUMERIC = /[^a-z0-9]/giu;

/** A lowercase/digit run immediately followed by an uppercase letter — a camelCase word boundary. */
const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/gu;

/** Any run of separator characters between words. */
const WORD_SEPARATOR = /[^a-zA-Z0-9]+/u;

/** `column`, lowercased with every non-alphanumeric character stripped. */
const normalize = (column: string): string => column.replaceAll(NON_ALPHANUMERIC, "").toLowerCase();

/** Split a column name into lowercase words on camelCase boundaries and non-alphanumeric separators. */
const tokenize = (column: string): string[] =>
    column
        .replaceAll(CAMEL_BOUNDARY, "$1_$2")
        .split(WORD_SEPARATOR)
        .filter((token) => token.length > 0)
        .map((token) => token.toLowerCase());

/**
 * {@link PII_FIELD_NAME_LIST}, normalized — so a column spelled with a different
 * separator or casing (`date_of_birth`, `DateOfBirth`) still matches a compound
 * entry (`dateOfBirth`) by its full name, not just a fragment of it.
 */
const NORMALIZED_PII_NAMES: ReadonlySet<string> = new Set(PII_FIELD_NAME_LIST.map((name) => normalize(name)));

/**
 * The {@link PII_FIELD_NAME_LIST} entries that are a single word on their own
 * (`email`, `phone`, `ssn`, `dob`, `address`, `passport`) — specific enough that
 * any ONE matching token in a compound column name (`email_address`, `homePhone`)
 * is reason enough to flag it. A compound PII name (`dateOfBirth`, `phoneNumber`,
 * `creditCard`) is deliberately excluded here: its individual words (`date`,
 * `number`, `card`) are common enough on their own that matching them as loose
 * tokens would flag unrelated columns — a compound name is only matched whole,
 * via {@link NORMALIZED_PII_NAMES}.
 */
const PII_TOKENS: ReadonlySet<string> = new Set(PII_FIELD_NAME_LIST.filter((name) => tokenize(name).length === 1).map((name) => name.toLowerCase()));

/**
 * Ownership / tenancy columns whose presence marks a table as holding user- or
 * tenant-scoped rows. Mirrors (does not import — `@lunora/codegen` depends on
 * `@lunora/advisor`, not the reverse) `@lunora/codegen`'s
 * `discover/owner-field-writes.ts` `IDENTITY_FIELDS` list, so the two
 * heuristics stay in lockstep. Kept deliberately tight to identity/tenancy
 * columns (not arbitrary foreign keys) to hold the false-positive rate down.
 */
export const OWNERSHIP_FIELD_NAMES: ReadonlySet<string> = new Set([
    "accountId",
    "authorId",
    "createdBy",
    "createdById",
    "organizationId",
    "orgId",
    "ownerId",
    "tenantId",
    "updatedBy",
    "userId",
    "workspaceId",
]);

/**
 * `true` when `column` names PII, judged two ways: the whole column (normalized)
 * matches a {@link PII_FIELD_NAME_LIST} entry exactly, or one of its words matches a
 * single-word entry.
 *
 * Token-based rather than a substring match, which would match a PII fragment
 * ANYWHERE in the normalized string — `dob` inside `adobeAssetId`, `ssn` inside
 * `classSnapshot` — turning unrelated columns into false positives. And
 * deliberately looser than bare set membership, which misses every real-world
 * spelling of a listed name (`emailAddress`, `home_phone`, `userSsn`).
 *
 * Still conservative in the other direction (not a full NLP classifier): a
 * genuinely unusual PII column name that shares no word with
 * {@link PII_FIELD_NAME_LIST} slips through, and that false negative is the cheaper
 * mistake here.
 *
 * This is the package's ONE PII-naming policy. Every lint that asks "is this
 * column PII?" goes through it — a second, weaker copy beside the set it derives
 * from is how eight listed names silently stopped being covered once before.
 */
export const isPiiColumn = (column: string): boolean => NORMALIZED_PII_NAMES.has(normalize(column)) || tokenize(column).some((token) => PII_TOKENS.has(token));

/**
 * `true` when `identifier` names one of `phrases`, matched on WORD boundaries.
 *
 * A substring scan matches a phrase ANYWHERE in the normalized string — `reset`
 * inside `updatePresets`, `otp` inside `snapshotPrune` and `listSlotProfiles` —
 * so plainly benign procedures come back tagged auth-sensitive. That is the
 * false-positive class {@link isPiiColumn} and the flag-polarity lint's own
 * tokenizer both exist to avoid, and a security lint that cries wolf on
 * `updatePresets` is how a team learns to ignore the advisor.
 *
 * A phrase matches when its words appear as a contiguous run of `identifier`'s
 * words (`signIn` matches `signInWithEmail`), or when the two normalize
 * identically (the identifier `signin` matches the phrase `signIn`). List a
 * phrase under every spelling a caller might write it as ONE word (`login` as
 * well as `logIn`): `loginHandler` tokenizes to `["login", "handler"]` and
 * shares no word with `logIn`.
 */
export const matchesNamePhrase = (identifier: string, phrases: ReadonlyArray<string>): boolean => {
    const tokens = tokenize(identifier);
    const normalized = normalize(identifier);

    return phrases.some((phrase) => {
        if (normalized === normalize(phrase)) {
            return true;
        }

        const words = tokenize(phrase);

        return words.length > 0 && tokens.some((_, start) => words.every((word, offset) => tokens[start + offset] === word));
    });
};

/**
 * The declared validator kind of `table`'s `column`, or `undefined` when the
 * table has no such column (or the feeder carries no column kinds at all).
 *
 * `columnKinds` is a plain object, so a bare index read inherits from
 * `Object.prototype`: a column named `toString`/`constructor` resolves to a
 * function and a type lint reports an ERROR whose detail is `[native code]`.
 * Own-property lookup keeps an undeclared column undeclared — the same hazard
 * {@link shardKindsByTable} answers with a `Map`.
 */
export const columnKind = (table: AdvisorTable, column: string): string | undefined =>
    table.columnKinds !== undefined && Object.hasOwn(table.columnKinds, column) ? table.columnKinds[column] : undefined;

/**
 * Framework-managed columns every table has implicitly. They never appear in a
 * table's declared `fields`, so a column-resolution check must treat them as
 * always valid (an index or relation may legitimately reference `_id`).
 */
export const SYSTEM_FIELDS: ReadonlySet<string> = new Set(["_creationTime", "_id"]);

/**
 * A table's declared columns that are ownership/tenancy- or PII-named, per
 * {@link OWNERSHIP_FIELD_NAMES} / {@link PII_FIELD_NAME_LIST}. The low-FP gate
 * `public_table_rls_optout_confusion` uses this to tell a genuinely public
 * lookup table (e.g. `emojis`, `countries`, no such columns) apart from a
 * `.public()` table that actually carries data an RLS opt-out would expose.
 */
export const ownershipOrPiiColumns = (table: AdvisorTable): string[] => table.fields.filter((field) => OWNERSHIP_FIELD_NAMES.has(field) || isPiiColumn(field));

/**
 * Build a `Set` of a table's columns (declared + system) once, so repeated
 * membership checks inside a hot loop are O(1) instead of an O(n)
 * `Array.includes` scan.
 */
export const tableColumnSet = (table: AdvisorTable): ReadonlySet<string> => new Set<string>([...SYSTEM_FIELDS, ...table.fields]);

/**
 * `true` when a procedure is both publicly-callable and write-shaped
 * (`mutation`/`action`) — the "public write" predicate re-derived inline
 * across several static security lints (e.g. `public_mutation_without_ratelimit`,
 * `user_creating_mutation_without_captcha`). `query` is read-only and an
 * `internal` procedure is server-called, so neither counts as an exposed write.
 */
export const isPublicWrite = (procedure: Pick<AdvisorProcedureProtection, "kind" | "visibility">): boolean =>
    procedure.visibility === "public" && (procedure.kind === "mutation" || procedure.kind === "action");

/**
 * Where a discovered query read sits, as the `file:line` string the query lints
 * put in their `detail`. Falls back to the bare file when the feeder could not
 * resolve a line (`0`), so the text never reads `messages:0`.
 */
export const queryReadLocation = (read: Pick<AdvisorQueryRead, "file" | "line">): string =>
    read.line > 0 ? `${read.file}:${read.line.toString()}` : read.file;

/**
 * Where a finding's detail places a call site: `` `send` (messages:12) `` for an
 * export, `` `openInvoice` (accounts/signup:9; a helper called by `a`, `b`) ``
 * for a helper — so every lint names the exported functions a helper's site runs
 * for — and `module scope (boot:2)` at module scope.
 */
export const callSiteWhere = (row: CallSiteRow): string => {
    const at = `${row.file}:${row.line.toString()}`;

    switch (row.scope.kind) {
        case "export": {
            return `\`${row.scope.name}\` (${at})`;
        }
        case "helper": {
            return `\`${row.scope.name}\` (${at}; ${helperRole(row.scope)})`;
        }
        default: {
            return `module scope (${at})`;
        }
    }
};

/** A call-site finding's location metadata: its {@link callSiteMetadata} plus `file` and `line`. */
export const callSiteFields = (row: CallSiteRow): CallSiteMetadata & { file: string; line: number } => {
    return { ...callSiteMetadata(row.scope), file: row.file, line: row.line };
};

/**
 * Table name -> declared storage tier, for the query lints that word a finding
 * by where the rows actually live (`shardBy` reads one Durable Object, `global`
 * reads D1, `root` reads the single DO). A `Map` so a table named `toString`
 * resolves to `undefined` and takes the neutral fallback, rather than to an
 * inherited `Object.prototype` member.
 */
export const shardKindsByTable = (schema: AdvisorSchema): ReadonlyMap<string, string | undefined> =>
    new Map(schema.tables.map((table) => [table.name, table.shardKind]));

/** The `namespace:export` key of one export, the form call edges and cron targets carry. */
export const functionKey = (file: string, exportName: string): string => `${sanitizeNamespace(file)}:${exportName}`;

/** `namespace:export` keys of the functions a read or write runs on behalf of, one per export that reaches its site. */
export const functionKeysOf = (file: string, scope: AdvisorCallSiteScope): string[] =>
    callSiteCallers(scope).map((exportName) => functionKey(file, exportName));

/**
 * Every function key that runs without a request: a call edge schedules it, or a cron
 * job fires it. A lint uses this to tell a sweep that the server drives from one a caller reaches.
 */
export const scheduledFunctionKeys = (
    callEdges: ReadonlyArray<AdvisorCallEdge> | undefined,
    cronTargets: ReadonlyArray<string> | undefined,
): ReadonlySet<string> =>
    new Set([...(callEdges ?? []).flatMap((edge) => (edge.kind === "schedule" && edge.target !== undefined ? [edge.target] : [])), ...(cronTargets ?? [])]);

/** One row-changing write an export performs: its method, and the fields a patch writes. */
export interface RowChange {
    fields?: string[];
    method: string;
}

/** Row changes keyed `file:export:table`, so a lint asks "does this export change this table" with one lookup. */
export type RowChanges = ReadonlyMap<string, ReadonlyArray<RowChange>>;

/**
 * Every row-changing write, keyed by the export that performs it. A direct write
 * counts under each export that reaches its function. A write reached through a
 * helper in another file is counted by the row-effect evidence, under the export
 * that calls it. Built once per run.
 */
export const rowChangesOf = (writes: ReadonlyArray<AdvisorTableWrite> | undefined, effects: ReadonlyArray<AdvisorRowEffect> | undefined): RowChanges => {
    const changes = new Map<string, RowChange[]>();
    const add = (key: string, change: RowChange): void => {
        const existing = changes.get(key);

        if (existing === undefined) {
            changes.set(key, [change]);
        } else {
            existing.push(change);
        }
    };

    for (const write of writes ?? []) {
        if (ROW_CHANGING_WRITES.has(write.method)) {
            for (const caller of callSiteCallers(write.scope)) {
                add(`${write.file}:${caller}:${write.table}`, { fields: write.fields, method: write.method });
            }
        }
    }

    for (const effect of effects ?? []) {
        if (ROW_CHANGING_WRITES.has(effect.method)) {
            add(`${effect.file}:${effect.exportName}:${effect.table}`, { fields: effect.fields, method: effect.method });
        }
    }

    return changes;
};

/** The declared btree index fields of each read's index, looked up by table and index name, built once per run. */
export const indexFieldsLookup = (schema: AdvisorSchema): ((read: Pick<AdvisorQueryRead, "index" | "table">) => ReadonlyArray<string> | undefined) => {
    const indexes = new Map(
        schema.tables.map((table) => [table.name, new Map(table.indexes.filter((index) => index.kind === "index").map((index) => [index.name, index.fields]))]),
    );

    return (read) => {
        const name = read.index?.name;

        return name === undefined ? undefined : indexes.get(read.table)?.get(name);
    };
};

/**
 * True when a function that reads `read` also removes or moves a row it selects. The
 * function is every export that reaches the read's site. Index fields narrow a patch
 * to the writes that can change the range.
 */

/**
 * True when the given callers remove or move a row the read selects. The callers
 * default to every export that reaches the read's site. Index fields narrow a patch to
 * the writes that can change the range. A caller with no write of its own is not
 * helped by another caller's write, so pass the one caller whose progress is at issue.
 */
export const readRowsChanged = (
    changes: RowChanges,
    read: Pick<AdvisorQueryRead, "file" | "scope" | "table">,
    indexFields?: ReadonlyArray<string>,
    callers: ReadonlyArray<string> = callSiteCallers(read.scope),
): boolean => callers.some((caller) => (changes.get(`${read.file}:${caller}:${read.table}`) ?? []).some((change) => changeTouches(change, indexFields)));
