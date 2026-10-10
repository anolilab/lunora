/**
 * Staged replace import: a restore that spans many import requests and is
 * swapped in at the end.
 *
 * ## Protocol
 *
 * Stage: `POST /_lunora/admin/import?mode=replace[&tables=…]&stage=<session>`,
 * any number of NDJSON batches under one caller-chosen session id
 * (`[A-Za-z0-9_-]{1,64}`). Nothing a reader sees changes: shard-local rows wait
 * in each shard's staging table, `.global()` rows in D1's, section records on
 * the root shard and sealed chunks under
 * `_lunora/restore-session/<session>/<generation>/`. Every row is checked as it
 * is staged; a batch with a refused row (or a shard it could not reach) marks
 * the session rejected, and a rejected session is never committed.
 *
 * Commit: `POST /_lunora/admin/import/commit` `{ session }` swaps the snapshot
 * in. Abort: `POST /_lunora/admin/import/abort` `{ session }` drops the staging
 * (the data was never touched); refused (409) once a commit began.
 *
 * `?mode=replace` without `stage` is the same thing in one call: stage under a
 * fresh session, then commit (or abort on a refusal).
 *
 * ## What the commit guarantees
 *
 * Prepare: every shard first runs its swap in a transaction it rolls back (a
 * dry run). A row that would not land — no longer valid against the schema, an
 * `_id` owned by another table — refuses the commit before any shard is
 * written, and the caller can abort.
 *
 * Each shard then swaps in one Durable Object storage transaction: every
 * overwrite and every prune lands, or none does. Shards are not one transaction
 * with each other; each records that it committed, so a commit that failed
 * part-way (a shard unreachable) is finished by sending it again.
 *
 * `.global()` D1 tables, KV and storage have no transaction a swap could run
 * in: they are written after the shards, writes before deletes, each idempotent
 * on a retry (see `@lunora/d1`'s `import-staging` and
 * `./import-session-sections`). The auth tables swap in one transaction of the
 * auth store. The `.global()` and section halves are audited on the default
 * shard (`importGlobal` / `importSections`); each shard audits its own swap.
 *
 * ## Fail closed
 *
 * The root shard's manifest is the session's one source of truth, and every
 * transition on it is a compare-and-set. A staging request opens a batch before
 * it writes anything and closes it after; a batch that never closed (the request
 * died, the close failed) leaves the session incomplete, and an incomplete,
 * rejected, changed-since-prepare, aborting or unreadable session refuses the
 * commit before anything is written. A missing or expired manifest refuses too.
 * Each session has a generation minted with its manifest; shards, D1 and the
 * chunk prefix carry it, so rows a sweep has not cleared yet from an earlier
 * session of the same id are refused, never swapped in.
 *
 * ## Expiry
 *
 * An open session lives an hour after its last batch; shards keep its rows a
 * day. The next session opened sweeps expired ones: the root shard drops their
 * manifests and this module clears their other shards, their D1 rows and their
 * chunks — each by generation. A session whose commit began is never swept, and
 * no sweep deletes state it cannot read.
 */
import type { ImportManifest, ImportStepResult } from "@lunora/shard-engine";

import type { WorkerOptions } from "./create-worker";
import { LunoraError } from "./errors";
import type { ReplaceSection, SessionRef, StagedSectionRow } from "./import-session-sections";
import { commitSection, dropStagedObjects, REPLACE_SECTIONS, SECTION_TABLE, sectionUnsupported, stageSectionRows } from "./import-session-sections";
import type { ImportRowError, ImportShardFailure, RecordImportAudit } from "./import-stream";
import { auditPlane, bucketImportStream, UNSHARDED_WARNING } from "./import-stream";
import type { ImportSessionShardOutcome, QueryCoordinator } from "./query-coordinator";
import type { ShardNamespaceLike } from "./resolve-shard";

/** Everything a session call needs: the worker's options, its coordinator, the pinned namespace, the forwarded admin headers and the audit sink. */
interface ImportSessionContext {
    coordinator: QueryCoordinator;
    headers: Record<string, string>;
    namespace: ShardNamespaceLike;
    options: WorkerOptions;
    recordAudit: RecordImportAudit;
}

/** One staging request's answer. */
interface StageImportResult {
    errors: ImportRowError[];
    failed: ImportShardFailure[];
    received: number;
    session: string;
    /** Rows staged per table (`$`-tables for section records). */
    staged: Record<string, number>;
    warnings?: string[];
}

/** A commit's answer. `refused`: nothing was written. `partial`: some steps landed — send the commit again. */
type CommitImportResult =
    | { deleted: Record<string, number>; inserted: Record<string, number>; session: string; status: "committed"; warnings?: string[] }
    | { errors: ImportRowError[]; failed: ImportShardFailure[]; session: string; status: "partial" | "refused" };

const FN = {
    abort: "__lunora_admin__:importAbort",
    commit: "__lunora_admin__:importCommit",
    manifest: "__lunora_admin__:importManifest",
    stage: "__lunora_admin__:importStage",
    stagedRows: "__lunora_admin__:importStagedRows",
} as const;

/** Statuses for the session codes a shard or D1 answers with — the coordinator carries the code, not the status. */
const SESSION_STATUS: Readonly<Record<string, number>> = {
    BAD_REQUEST: 400,
    IMPORT_SESSION_CHANGED: 409,
    IMPORT_SESSION_CLOSED: 409,
    IMPORT_SESSION_COMMITTED: 409,
    IMPORT_SESSION_COMMITTING: 409,
    IMPORT_SESSION_CORRUPT: 409,
    IMPORT_SESSION_EXPIRED: 410,
    IMPORT_SESSION_INCOMPLETE: 409,
    IMPORT_SESSION_MISMATCH: 400,
    IMPORT_SESSION_NOT_COMMITTING: 409,
    IMPORT_SESSION_NOT_FOUND: 404,
    IMPORT_SESSION_REJECTED: 409,
    IMPORT_SESSION_STALE: 409,
};

const SESSION_PATTERN = /^[\w-]{1,64}$/u;

/** Refuse a session id before it names a storage prefix or reaches a shard. */
const assertSession = (session: string): void => {
    if (!SESSION_PATTERN.test(session)) {
        throw new LunoraError("An import session id is 1-64 characters of [A-Za-z0-9_-]", { code: "BAD_REQUEST", status: 400 });
    }
};

const defaultShardOf = (options: WorkerOptions): string => options.defaultShardKey ?? "__root__";

const isGlobalTable = (options: WorkerOptions, table: string): boolean => options.resolveTableSharding?.(table)?.mode.kind === "global";

const splitScope = (options: WorkerOptions, tables: ReadonlyArray<string>): { globalScope: string[]; shardScope: string[] } => {
    return {
        globalScope: tables.filter((table) => isGlobalTable(options, table)),
        shardScope: tables.filter((table) => !isGlobalTable(options, table)),
    };
};

const sumInto = (target: Record<string, number>, source: Record<string, number> | undefined): void => {
    for (const [table, count] of Object.entries(source ?? {})) {
        // eslint-disable-next-line no-param-reassign -- caller-owned accumulator
        target[table] = (target[table] ?? 0) + count;
    }
};

const failureOf = (outcome: ImportSessionShardOutcome): ImportShardFailure | undefined =>
    outcome.error ? { message: outcome.error.message, shardKey: outcome.shardKey, timedOut: outcome.error.timedOut } : undefined;

/** Turn a session failure that carries a code (a shard's, or `@lunora/d1`'s) into its HTTP answer; an unknown one is a 502. */
const sessionError = (code: string, message: string): LunoraError => new LunoraError(message, { code, status: SESSION_STATUS[code] ?? 502 });

const rethrowCoded = (error: unknown): never => {
    const code = (error as { code?: unknown } | null)?.code;

    if (typeof code === "string" && code in SESSION_STATUS && !(error instanceof LunoraError)) {
        throw sessionError(code, error instanceof Error ? error.message : String(error));
    }

    throw error;
};

/** Call the session RPC on the root shard (which keeps the manifest and the section records). */
const callRoot = async <T>(context: ImportSessionContext, functionPath: string, args: Record<string, unknown>): Promise<T> => {
    const [outcome] = await context.coordinator.orchestrateImportSession(context.namespace, {
        calls: [{ args, shardKey: defaultShardOf(context.options) }],
        functionPath,
        headers: context.headers,
    });

    if (outcome === undefined || outcome.error) {
        throw sessionError(outcome?.error?.code ?? "SHARD_UNREACHABLE", outcome?.error?.message ?? "the root shard did not answer");
    }

    return outcome.value as T;
};

/** The manifest, or `undefined` when there is none (or it expired while open). An unreadable one answers IMPORT_SESSION_CORRUPT from the shard. */
const readManifest = async (context: ImportSessionContext, session: string): Promise<ImportManifest | undefined> => {
    const answer = await callRoot<{ manifest?: ImportManifest | null } | null>(context, FN.manifest, { op: "get", session });

    if (answer === null || typeof answer !== "object" || !("manifest" in answer)) {
        throw sessionError("IMPORT_SESSION_CORRUPT", `the root shard answered no manifest for import session "${session}"`);
    }

    return answer.manifest ?? undefined;
};

const advance = async (context: ImportSessionContext, session: string, change: Record<string, unknown>): Promise<ImportManifest> => {
    const { manifest } = await callRoot<{ manifest: ImportManifest }>(context, FN.manifest, { op: "advance", session, ...change });

    return manifest;
};

const refOf = (manifest: ImportManifest): SessionRef => {
    return { generation: manifest.generation, session: manifest.session };
};

/** Drop a session's staging on its shards, in D1 and in storage — each by generation, so another session's rows are never touched. */
const dropStaging = async (context: ImportSessionContext, manifest: ImportManifest): Promise<void> => {
    const shards = manifest.shards.filter((shardKey) => shardKey !== defaultShardOf(context.options));
    const outcomes = await context.coordinator.orchestrateImportSession(context.namespace, {
        calls: shards.map((shardKey) => {
            return { args: { generation: manifest.generation, session: manifest.session }, shardKey };
        }),
        functionPath: FN.abort,
        headers: context.headers,
    });
    const unreachable = outcomes.find((outcome) => outcome.error);

    if (unreachable?.error) {
        throw sessionError("SHARD_UNREACHABLE", `could not drop the staging on shard "${unreachable.shardKey}": ${unreachable.error.message}`);
    }

    await context.options.importGlobalsStaging?.abort({ generation: manifest.generation, session: manifest.session }).catch(rethrowCoded);
    await dropStagedObjects(context.options, refOf(manifest));
};

/** Clear what expired sessions left on other shards, in D1 and in storage. Best effort: anything missed expires again on its own shard. */
const clearExpired = async (context: ImportSessionContext, expired: ReadonlyArray<ImportManifest>): Promise<void> => {
    for (const manifest of expired) {
        // eslint-disable-next-line no-await-in-loop -- sessions one at a time; this is housekeeping
        await dropStaging(context, manifest).catch(() => undefined);
    }
};

/** Send each shard its staged rows; gathers the rows it refused and the shards it could not reach. */
const stageOnShards = async (
    context: ImportSessionContext,
    ref: SessionRef,
    shardScope: ReadonlyArray<string>,
    calls: ReadonlyMap<string, ReadonlyArray<{ doc: Record<string, unknown>; line: number; table: string }>>,
): Promise<{ errors: ImportRowError[]; failed: ImportShardFailure[]; staged: Record<string, number> }> => {
    const errors: ImportRowError[] = [];
    const failed: ImportShardFailure[] = [];
    const staged: Record<string, number> = {};
    const outcomes = await context.coordinator.orchestrateImportSession(context.namespace, {
        calls: [...calls].map(([shardKey, rows]) => {
            return { args: { generation: ref.generation, rows, session: ref.session, tables: shardScope }, shardKey };
        }),
        functionPath: FN.stage,
        headers: context.headers,
    });

    for (const outcome of outcomes) {
        const failure = failureOf(outcome);

        if (failure) {
            failed.push(failure);
            continue;
        }

        const value = outcome.value as { errors?: ImportRowError[]; staged?: Record<string, number> };

        errors.push(...(value.errors ?? []));
        sumInto(staged, value.staged);
    }

    return { errors, failed, staged };
};

/**
 * Stage one NDJSON batch into `session`. Opens the session on its first batch.
 * Writes nothing a reader sees.
 *
 * The batch is opened on the manifest before anything is staged and closed
 * after, with what it refused. When the close never lands — this request dies,
 * or the close itself fails — the batch stays open and the session can never be
 * committed, only aborted.
 */
const stageImport = async (request: Request, context: ImportSessionContext, session: string, tables: ReadonlyArray<string>): Promise<StageImportResult> => {
    const { options } = context;
    const defaultShard = defaultShardOf(options);
    const { globalScope, shardScope } = splitScope(options, tables);

    assertSession(session);

    // Refused before reading a byte: with no global stager the `.global()` tables
    // could be neither written nor emptied, and a replace that silently skips half
    // its scope is not a replace.
    if (globalScope.length > 0 && !options.importGlobalsStaging) {
        throw new LunoraError(`replace import covers .global() table(s) ${globalScope.join(", ")} but no \`importGlobalsStaging\` is configured`, {
            code: "GLOBAL_NOT_CONFIGURED",
            status: 400,
        });
    }

    const bucket = await bucketImportStream(request, options, defaultShard, new Set(tables));
    const calls = new Map<string, { doc: Record<string, unknown>; line: number; table: string }[]>();

    for (const batch of bucket.perShard.values()) {
        calls.set(batch.shardKey, [...batch.rows]);
    }

    const hasSections = bucket.sectionRows.length > 0;
    const opened = await callRoot<{ created: boolean; expired: ImportManifest[]; manifest: ImportManifest }>(context, FN.manifest, {
        begin: true,
        globals: bucket.globalRows.length > 0,
        op: "touch",
        received: bucket.received,
        session,
        shards: [...calls.keys(), ...(hasSections ? [defaultShard] : [])],
        storage: bucket.sectionRows.some((row) => row.table === "$kv" || row.table === "$storage"),
        tables,
    });

    if (opened.created && opened.expired.length > 0) {
        await clearExpired(context, opened.expired);
    }

    const ref = refOf(opened.manifest);
    const sections = await stageSectionRows(options, ref, bucket.sectionRows);
    const errors = [...bucket.errors, ...sections.errors];
    const failed: ImportShardFailure[] = [];
    const staged: Record<string, number> = {};
    const warnings = options.resolveTableSharding === undefined && bucket.perShard.size > 0 ? [UNSHARDED_WARNING] : [];

    if (sections.rows.length > 0) {
        calls.set(defaultShard, [...(calls.get(defaultShard) ?? []), ...sections.rows]);
    }

    if (errors.length === 0) {
        const shardStage = await stageOnShards(context, ref, shardScope, calls);

        errors.push(...shardStage.errors);
        failed.push(...shardStage.failed);
        sumInto(staged, shardStage.staged);

        if (bucket.globalRows.length > 0 && options.importGlobalsStaging) {
            const result = await options.importGlobalsStaging
                .stage({ generation: ref.generation, rows: bucket.globalRows, session, tables: globalScope })
                .catch(rethrowCoded);

            errors.push(...result.errors);
            sumInto(staged, result.staged);
        }
    }

    await callRoot(context, FN.manifest, {
        begin: false,
        op: "touch",
        rejected: errors.length + failed.length,
        sections: sections.sections,
        session,
        tables,
    });

    return { errors, failed, received: bucket.received, session, staged, ...(warnings.length > 0 ? { warnings } : {}) };
};

/** A section's staged records, paged off the root shard. A KV page is kept small: each value is up to ~700 KB. */
const stagedRecords = async function* stagedRecords(context: ImportSessionContext, session: string, section: ReplaceSection): AsyncGenerator<StagedSectionRow> {
    let afterSeq = 0;

    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- each page starts after the previous one
        const page = await callRoot<{ rows: StagedSectionRow[]; seq: number }>(context, FN.stagedRows, {
            afterSeq,
            limit: section === "auth" ? 200 : 8,
            sections: [SECTION_TABLE[section]],
            session,
        });

        if (page.rows.length === 0) {
            return;
        }

        yield* page.rows;
        afterSeq = page.seq;
    }
};

/** Fan `importCommit` out to every shard the replace must reach, as a dry run or for real. */
const commitShards = async (
    context: ImportSessionContext,
    manifest: ImportManifest,
    targets: ReadonlyArray<string>,
    shardScope: ReadonlyArray<string>,
    dryRun: boolean,
): Promise<{ deleted: Record<string, number>; errors: ImportRowError[]; failed: ImportShardFailure[]; inserted: Record<string, number> }> => {
    const outcomes = await context.coordinator.orchestrateImportSession(context.namespace, {
        calls: targets.map((shardKey) => {
            return {
                args: { dryRun, generation: manifest.generation, session: manifest.session, staged: manifest.shards.includes(shardKey), tables: shardScope },
                shardKey,
            };
        }),
        functionPath: FN.commit,
        headers: context.headers,
    });
    const totals = { deleted: {}, errors: [] as ImportRowError[], failed: [] as ImportShardFailure[], inserted: {} };

    for (const outcome of outcomes) {
        const failure = failureOf(outcome);

        if (failure) {
            totals.failed.push(failure);
            continue;
        }

        const value = outcome.value as { deleted?: Record<string, number>; errors?: ImportRowError[]; inserted?: Record<string, number> };

        totals.errors.push(...(value.errors ?? []));
        sumInto(totals.deleted, value.deleted);
        sumInto(totals.inserted, value.inserted);
    }

    return totals;
};

const totalsOf = (manifest: ImportManifest): { deleted: Record<string, number>; inserted: Record<string, number>; warnings: string[] } => {
    const deleted: Record<string, number> = {};
    const inserted: Record<string, number> = {};
    const warnings: string[] = [];

    for (const step of Object.values(manifest.steps)) {
        sumInto(deleted, step.deleted);
        sumInto(inserted, step.inserted);
        warnings.push(...(step.warnings ?? []));
    }

    return { deleted, inserted, warnings };
};

const committed = (manifest: ImportManifest): CommitImportResult => {
    const { deleted, inserted, warnings } = totalsOf(manifest);

    return { deleted, inserted, session: manifest.session, status: "committed", ...(warnings.length > 0 ? { warnings } : {}) };
};

/** Refuse what the commit could never finish, before it writes anything. The root shard re-checks the session's own state on the compare-and-set. */
const assertCommittable = (options: WorkerOptions, manifest: ImportManifest, globalScope: ReadonlyArray<string>): void => {
    if (manifest.state === "aborting") {
        throw sessionError("IMPORT_SESSION_CLOSED", `import session "${manifest.session}" is being aborted`);
    }

    if (manifest.state === "open" && manifest.rejected > 0) {
        throw sessionError(
            "IMPORT_SESSION_REJECTED",
            `import session "${manifest.session}" had ${String(manifest.rejected)} refused row(s) or unreachable shard(s) while staging — abort it`,
        );
    }

    if (manifest.state === "open" && manifest.pending > 0) {
        throw sessionError(
            "IMPORT_SESSION_INCOMPLETE",
            `import session "${manifest.session}" has ${String(manifest.pending)} staging request(s) that never finished — abort it`,
        );
    }

    if (globalScope.length > 0 && !options.importGlobalsStaging) {
        throw new LunoraError("replace import covers .global() tables but no `importGlobalsStaging` is configured", {
            code: "GLOBAL_NOT_CONFIGURED",
            status: 400,
        });
    }

    for (const section of manifest.sections) {
        const reason = sectionUnsupported(options, section);

        if (reason !== undefined) {
            throw new LunoraError(reason, { code: "SECTION_NOT_CONFIGURED", status: 400 });
        }
    }
};

/** Run one step unless the manifest says it already ran, and record it. */
const runStep = async (
    context: ImportSessionContext,
    manifest: ImportManifest,
    step: string,
    run: () => Promise<ImportStepResult>,
): Promise<ImportManifest> => {
    if (manifest.steps[step] !== undefined) {
        return manifest;
    }

    const stepResult = await run();

    return advance(context, manifest.session, { step, stepResult });
};

/** Raised inside a step to end the commit as `partial`, carrying what went wrong. */
class StepFailure extends Error {
    public readonly errors: ImportRowError[];

    public readonly failed: ImportShardFailure[];

    public constructor(errors: ImportRowError[], failed: ImportShardFailure[]) {
        super("commit step failed");
        this.errors = errors;
        this.failed = failed;
    }
}

const sectionFailure = (section: ReplaceSection, error: unknown): StepFailure =>
    new StepFailure(
        [{ code: "SECTION_COMMIT_FAILED", line: 0, message: error instanceof Error ? error.message : String(error), table: SECTION_TABLE[section] }],
        [],
    );

/** Audit a step on the default shard; a failed audit write is a warning on the step, never a failed commit of data already written. */
const auditedStep = async (
    context: ImportSessionContext,
    op: "importGlobal" | "importSections",
    session: string,
    tables: ReadonlyArray<string>,
    result: ImportStepResult,
): Promise<ImportStepResult> => {
    const warnings = [...(result.warnings ?? [])];

    await auditPlane(
        context.recordAudit,
        warnings,
        op,
        { conflicts: 0, deleted: result.deleted, errors: [], inserted: result.inserted },
        {
            replaceTables: tables,
            session,
            tables,
        },
    );

    return { ...result, ...(warnings.length > 0 ? { warnings } : {}) };
};

/** The commit's writing steps, in order: shards, `.global()`, then the sections. A {@link StepFailure} ends it as `partial`. */
const runCommitSteps = async (
    context: ImportSessionContext,
    start: ImportManifest,
    scope: { globalScope: ReadonlyArray<string>; shardScope: ReadonlyArray<string>; targets: ReadonlyArray<string> },
): Promise<ImportManifest> => {
    const { options } = context;
    const { session } = start;
    let manifest = start;

    if (scope.targets.length > 0) {
        manifest = await runStep(context, manifest, "shards", async () => {
            const result = await commitShards(context, start, scope.targets, scope.shardScope, false);

            if (result.errors.length > 0 || result.failed.length > 0) {
                throw new StepFailure(result.errors, result.failed);
            }

            return { deleted: result.deleted, inserted: result.inserted };
        });
    }

    const staging = options.importGlobalsStaging;

    if (scope.globalScope.length > 0 && staging) {
        manifest = await runStep(context, manifest, "globals", async () => {
            const result = await staging
                .commit({ generation: start.generation, session, staged: start.globals, tables: scope.globalScope })
                .catch(rethrowCoded);

            if (result.errors.length > 0) {
                throw new StepFailure([...result.errors], []);
            }

            return auditedStep(context, "importGlobal", session, scope.globalScope, { deleted: result.deleted ?? {}, inserted: result.inserted });
        });
    }

    for (const section of REPLACE_SECTIONS.filter((name) => start.sections.includes(name))) {
        // eslint-disable-next-line no-await-in-loop -- steps run in order: auth, then KV, then storage
        manifest = await runStep(context, manifest, section, async () => {
            const result = await commitSection(options, refOf(start), section, stagedRecords(context, session, section)).catch((error: unknown) => {
                throw sectionFailure(section, error);
            });

            return auditedStep(context, "importSections", session, [SECTION_TABLE[section]], result);
        });
    }

    return manifest;
};

/** Swap a staged session in. See the module doc for what holds at each step. */
const commitImport = async (context: ImportSessionContext, session: string): Promise<CommitImportResult> => {
    const { options } = context;

    assertSession(session);
    let manifest = await readManifest(context, session);

    if (manifest === undefined) {
        throw sessionError("IMPORT_SESSION_NOT_FOUND", `import session "${session}" does not exist or has expired`);
    }

    if (manifest.state === "committed") {
        return committed(manifest);
    }

    const { globalScope, shardScope } = splitScope(options, manifest.tables);

    assertCommittable(options, manifest, globalScope);

    const targets =
        shardScope.length === 0
            ? []
            : [...new Set([...manifest.shards, ...(await context.coordinator.shardKeysForTables(shardScope, defaultShardOf(options)))])];

    if (manifest.state === "open") {
        const prepared = await commitShards(context, manifest, targets, shardScope, true);

        if (prepared.errors.length > 0 || prepared.failed.length > 0) {
            return { errors: prepared.errors, failed: prepared.failed, session, status: "refused" };
        }

        // The compare-and-set: refused unless the session is still open, clean, and took no batch since this prepare read it.
        manifest = await advance(context, session, { batches: manifest.batches, state: "committing" });
    }

    try {
        await runCommitSteps(context, manifest, { globalScope, shardScope, targets });
    } catch (error: unknown) {
        if (error instanceof StepFailure) {
            return { errors: error.errors, failed: error.failed, session, status: "partial" };
        }

        throw error;
    }

    manifest = await advance(context, session, { state: "committed" });

    // Only now that the commit is recorded are the staged chunks unneeded: the
    // storage step keeps them so a retry can re-assemble. Best effort — what this
    // misses, the expiry sweep drops by generation.
    await dropStagedObjects(options, refOf(manifest)).catch(() => undefined);

    return committed(manifest);
};

/**
 * Drop a session that has not begun committing. The manifest moves to
 * `aborting` first (a compare-and-set, so a commit cannot begin after), the
 * staging is dropped by generation, and the manifest goes last: an abort that
 * fails part-way leaves the session `aborting` — never committable — and is
 * finished by sending it again.
 */
const abortImport = async (context: ImportSessionContext, session: string): Promise<{ aborted: boolean }> => {
    assertSession(session);

    const manifest = await readManifest(context, session);

    if (manifest === undefined) {
        return { aborted: false };
    }

    if (manifest.state === "committed" || manifest.state === "committing") {
        throw sessionError(
            manifest.state === "committed" ? "IMPORT_SESSION_COMMITTED" : "IMPORT_SESSION_COMMITTING",
            manifest.state === "committed"
                ? `import session "${session}" is already committed`
                : `import session "${session}" is being committed — send the commit again to finish it`,
        );
    }

    const aborting = await advance(context, session, { state: "aborting" });

    await dropStaging(context, aborting);
    await callRoot(context, FN.manifest, { op: "drop", session });

    return { aborted: true };
};

/**
 * A replace in one request: stage under a fresh session, then commit — or, on a
 * refusal, abort, so nothing is written. Answers the import endpoint's shape.
 */
const replaceImport = async (
    request: Request,
    context: ImportSessionContext,
    tables: ReadonlyArray<string>,
): Promise<{
    conflicts: number;
    deleted: Record<string, number>;
    errors: ImportRowError[];
    failed: ImportShardFailure[];
    inserted: Record<string, number>;
    received: number;
    warnings?: string[];
}> => {
    const session = `once-${crypto.randomUUID()}`;
    const staged = await stageImport(request, context, session, tables);
    const refused = { conflicts: 0, deleted: {}, inserted: {}, received: staged.received, ...(staged.warnings ? { warnings: staged.warnings } : {}) };

    if (staged.errors.length > 0 || staged.failed.length > 0) {
        await abortImport(context, session).catch(() => undefined);

        return { ...refused, errors: staged.errors, failed: staged.failed };
    }

    const outcome = await commitImport(context, session);

    if (outcome.status === "refused") {
        await abortImport(context, session).catch(() => undefined);
    }

    if (outcome.status !== "committed") {
        return { ...refused, errors: outcome.errors, failed: outcome.failed };
    }

    const warnings = [...(staged.warnings ?? []), ...(outcome.warnings ?? [])];

    return {
        conflicts: 0,
        deleted: outcome.deleted,
        errors: [],
        failed: [],
        inserted: outcome.inserted,
        received: staged.received,
        ...(warnings.length > 0 ? { warnings } : {}),
    };
};

export type { CommitImportResult, ImportSessionContext, StageImportResult };
export { abortImport, commitImport, replaceImport, stageImport };
