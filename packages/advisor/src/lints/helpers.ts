import type { AdvisorProcedureProtection } from "../procedure-protections";
import type { AdvisorQueryRead } from "../queries";
import type { AdvisorSchema, AdvisorTable } from "../schema";

/**
 * Ownership / tenancy columns whose presence marks a table as holding user- or
 * tenant-scoped rows. Mirrors (does not import — `@lunora/codegen` depends on
 * `@lunora/advisor`, not the reverse) `@lunora/codegen`'s
 * `discover-owner-field-writes.ts` `IDENTITY_FIELDS` list, so the two
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
 * Personally-identifiable-information columns whose presence marks a table as
 * holding sensitive personal data. Kept deliberately tight to unambiguous PII
 * field names — not broad "sounds personal" guesses — to hold the
 * false-positive rate down, the same exact-name-membership convention as
 * {@link OWNERSHIP_FIELD_NAMES}.
 */
export const PII_FIELD_NAMES: ReadonlySet<string> = new Set([
    "address",
    "dateOfBirth",
    "dob",
    "email",
    "firstName",
    "lastName",
    "phone",
    "phoneNumber",
    "socialSecurityNumber",
    "ssn",
]);

/**
 * Framework-managed columns every table has implicitly. They never appear in a
 * table's declared `fields`, so a column-resolution check must treat them as
 * always valid (an index or relation may legitimately reference `_id`).
 */
export const SYSTEM_FIELDS: ReadonlySet<string> = new Set(["_creationTime", "_id"]);

/**
 * A table's declared columns that are ownership/tenancy- or PII-named, per
 * {@link OWNERSHIP_FIELD_NAMES} / {@link PII_FIELD_NAMES}. The low-FP gate
 * `public_table_rls_optout_confusion` uses this to tell a genuinely public
 * lookup table (e.g. `emojis`, `countries`, no such columns) apart from a
 * `.public()` table that actually carries data an RLS opt-out would expose.
 */
export const ownershipOrPiiColumns = (table: AdvisorTable): string[] =>
    table.fields.filter((field) => OWNERSHIP_FIELD_NAMES.has(field) || PII_FIELD_NAMES.has(field));

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
 * Table name -> declared storage tier, for the query lints that word a finding
 * by where the rows actually live (`shardBy` reads one Durable Object, `global`
 * reads D1, `root` reads the single DO). A `Map` so a table named `toString`
 * resolves to `undefined` and takes the neutral fallback, rather than to an
 * inherited `Object.prototype` member.
 */
export const shardKindsByTable = (schema: AdvisorSchema): ReadonlyMap<string, string | undefined> =>
    new Map(schema.tables.map((table) => [table.name, table.shardKind]));
