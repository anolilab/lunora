/**
 * Pre-deploy schema-drift gate.
 *
 * Reads the committed structural baseline (`lunora/.lunora-schema.json`),
 * compares it against the snapshot codegen produced this run, and decides
 * whether breaking drift that no new data migration covers should block the
 * deploy. The pure diff/classify/decision logic lives in `@lunora/codegen`
 * (`evaluateSchemaDrift`); this module is the thin I/O + logging shell the
 * deploy / verify / prepare commands call, mirroring the D1-placeholder guard.
 *
 * The baseline is NOT re-blessed inline: a drifting-but-allowed run returns a
 * `rebless` thunk the caller invokes only AFTER the operation succeeds (e.g.
 * after `wrangler deploy` exits 0). Re-blessing before the deploy can still fail
 * would advance the committed baseline past a breaking change that never
 * shipped, silently defeating the gate on the retry — so the write is deferred
 * to the command's success path.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { CodegenResult, SchemaDriftDecision, SchemaSnapshot } from "@lunora/codegen";
import { evaluateSchemaDrift, parseSchemaSnapshot, SchemaSnapshotParseError, serializeSchemaSnapshot } from "@lunora/codegen";

import type { Logger } from "./logger";
import type { StoredRowVerdict } from "./stored-row-check";
import { describeFailures, isRowCheckable } from "./stored-row-check";

/** Counts the stored rows a widened TTL deletes on the next sweep, per table, or says why it could not. Only `lunora deploy` has one. */
type ExpiringRowCounter = (changes: ReadonlyArray<SchemaDriftDecision["changes"][number]>) => Promise<ReadonlyMap<string, number> | string>;

/** Reads the deployment's stored rows for `changes` and judges them against the new schema. Only `lunora deploy` has one. */
type StoredRowChecker = (changes: ReadonlyArray<SchemaDriftDecision["uncovered"][number]>) => Promise<StoredRowVerdict>;

/**
 * The committed baseline, classified so the gate can treat "no baseline yet" (a
 * legitimate first capture — never blocks) differently from "present but
 * corrupt" (must block rather than silently degrade to a first capture and
 * overwrite the bad file). `parseSchemaSnapshot` throws on malformed content and
 * returns `undefined` only for an empty file.
 */
type BaselineRead = { snapshot: SchemaSnapshot; status: "ok" } | { status: "absent" } | { status: "corrupt" };

const readBaseline = (snapshotPath: string): BaselineRead => {
    if (!existsSync(snapshotPath)) {
        return { status: "absent" };
    }

    let content: string;

    try {
        content = readFileSync(snapshotPath, "utf8");
    } catch {
        return { status: "corrupt" };
    }

    try {
        const snapshot = parseSchemaSnapshot(content);

        // An empty/whitespace file parses to `undefined` — treat it as corrupt
        // (a committed baseline should never be blank), not a first capture.
        return snapshot === undefined ? { status: "corrupt" } : { snapshot, status: "ok" };
    } catch (error: unknown) {
        if (error instanceof SchemaSnapshotParseError) {
            return { status: "corrupt" };
        }

        throw error;
    }
};

/** Write the current snapshot to the committed baseline path. */
const writeBaseline = (snapshotPath: string, snapshot: SchemaSnapshot): void => {
    writeFileSync(snapshotPath, serializeSchemaSnapshot(snapshot), "utf8");
};

/** The structured outcome a command embeds in its `--format json` result + uses for exit code. */
interface SchemaDriftGateResult {
    /** True when the deploy must be aborted with a non-zero exit. */
    blocked: boolean;
    /** Per-change classification (both severities), for machine-readable output. */
    changes: SchemaDriftDecision["changes"];
    /** The actionable explanation, empty string when there was no drift. */
    reason: string;

    /**
     * Present when the run drifted but is allowed to proceed: invoke it AFTER the
     * operation succeeds to advance the committed baseline to the current shape.
     * Undefined when there is nothing to re-bless (no drift, blocked, or read-only).
     */
    rebless?: () => void;
}

/**
 * Run the schema-drift gate against the snapshot codegen produced. `options`
 * carries `codegen` (this run's `CodegenResult`, with the current snapshot +
 * baseline path), `allowDrift` (the `--allow-schema-drift` override — report but
 * never block, check nothing, leave the baseline alone), and `readOnly` (evaluate +
 * report but never write — used by `lunora verify`).
 *
 * The returned `rebless` thunk (when present) is the ONLY baseline write — the
 * caller invokes it on success so a failed deploy never advances the baseline.
 */
interface GateContext {
    checkStoredRows?: StoredRowChecker;
    command?: string;
    countExpiringRows?: ExpiringRowCounter;
    logger: Logger;
    readOnly: boolean;
    rebless: () => void;
    snapshotPath: string;
}

/**
 * Outcome for a present-but-corrupt baseline: block, so drift isn't silently skipped and the
 * bad file isn't auto-overwritten. Deleting the file is the way out: an absent baseline is a
 * first capture, which the next run writes from the current schema.
 */
const corruptBaselineResult = (context: GateContext): SchemaDriftGateResult => {
    const reason =
        `schema-drift gate: the committed baseline ${context.snapshotPath} is unreadable or malformed, so schema drift cannot be checked. ` +
        `Fix it (e.g. resolve a merge conflict in lunora/.lunora-schema.json), or delete it: the next run captures a fresh baseline from the current schema, checking nothing against the old one.`;

    // Read-only callers (verify) own the reporting — staying silent here avoids
    // the message being logged twice.
    if (!context.readOnly) {
        context.logger.error(reason);
    }

    return { blocked: true, changes: [], reason };
};

/** The count clause of a TTL warning: how many rows the next sweep deletes, or why that is not known. */
const expiryNote = (count: number | undefined, counts: ReadonlyMap<string, number> | string | undefined, canCount: boolean): string => {
    if (count !== undefined) {
        return ` — ${String(count)} stored row(s) are past the new cutoff and are deleted on the next sweep`;
    }

    if (typeof counts === "string") {
        return ` (the affected rows could not be counted: ${counts})`;
    }

    return canCount ? "" : " (the affected rows are counted by `lunora deploy`, which reads the deployed worker)";
};

/**
 * Say, for a run that goes ahead, what it leaves behind or sweeps: a dropped table's rows left in place, a removed relation's
 * behaviour, a TTL that now expires rows already on disk (counted when the deployment can be read).
 */
const warnAboutProceeding = async (changes: SchemaDriftDecision["changes"], context: GateContext): Promise<void> => {
    if (context.readOnly) {
        return;
    }

    const warned = changes.filter((change) => change.warning === true);
    const expiring = warned.filter((change) => change.expiry !== undefined);
    const counts = expiring.length > 0 && context.countExpiringRows !== undefined ? await context.countExpiringRows(expiring) : undefined;

    for (const change of warned) {
        const count = typeof counts === "object" && change.table !== undefined ? counts.get(change.table) : undefined;
        const suffix = change.expiry === undefined ? "" : expiryNote(count, counts, context.countExpiringRows !== undefined);

        context.logger.warn(`schema-drift warning: ${change.summary}${suffix}`);
    }
};

/** A run `--allow-schema-drift` let through: nothing is checked and the baseline stays at its committed shape. */
const overriddenResult = (overridden: SchemaDriftDecision, context: GateContext): SchemaDriftGateResult => {
    if (!context.readOnly) {
        context.logger.warn(`schema baseline left at its committed shape — --allow-schema-drift overrides this run only: ${context.snapshotPath}`);
    }

    return { blocked: false, changes: overridden.changes, reason: overridden.reason };
};

/** Why the stored rows did not clear the block, for the end of the gate's message. */
const verdictNote = (verdict: StoredRowVerdict | undefined): string => {
    if (verdict?.kind === "fails") {
        return `\n\n${describeFailures(verdict)}`;
    }

    return verdict?.kind === "inconclusive" ? `\n\nThe stored rows were not checked: ${verdict.reason}.` : "";
};

/**
 * Read the stored rows when they can decide the outcome: every blocking change is one the rows
 * decide (a field's validator, a removed field, a new unique constraint). A decision holding any
 * other change is never settled by rows, so it is never read. A command with no deployment to
 * read (`prepare`, `build`) answers "inconclusive", so it can never clear a shape unchecked.
 */
const storedRowVerdict = async (decision: SchemaDriftDecision, context: GateContext): Promise<StoredRowVerdict | undefined> => {
    const checkable = decision.uncovered.filter((change) => isRowCheckable(change));
    const decisive = checkable.length > 0 && checkable.length === decision.uncovered.length;

    if (!decisive || context.readOnly) {
        return undefined;
    }

    if (context.checkStoredRows === undefined) {
        return {
            kind: "inconclusive",
            reason: `\`lunora ${context.command ?? "prepare"}\` does not read a deployment; run \`lunora deploy\`, which checks the stored rows first`,
        };
    }

    return context.checkStoredRows(checkable);
};

/**
 * Outcome for a blocking decision. Stored rows that all fit the new schema clear it — the shape
 * is then simply true of the data, so the baseline advances on success. Rows that contradict it,
 * or could not be read, keep the block.
 */
const blockedDecisionResult = async (decision: SchemaDriftDecision, context: GateContext): Promise<SchemaDriftGateResult> => {
    const verdict = await storedRowVerdict(decision, context);

    if (verdict?.kind === "conforms") {
        context.logger.success(
            `schema-drift gate: all ${String(verdict.rows)} stored row(s) of ${verdict.tables.join(", ")} fit the new schema — the change needs no backfill`,
        );

        await warnAboutProceeding(decision.changes, context);

        return { blocked: false, changes: decision.changes, reason: decision.reason, rebless: context.rebless };
    }

    const reason = `${decision.reason}${verdictNote(verdict)}`;

    if (!context.readOnly) {
        context.logger.error(reason);
    }

    return { blocked: true, changes: decision.changes, reason };
};

const runSchemaDriftGate = async (options: {
    allowDrift: boolean;

    /**
     * Reads the deployment's stored rows. Present only where a deployment can be
     * reached (`lunora deploy`), so the offline commands keep their answer.
     */
    checkStoredRows?: StoredRowChecker;
    codegen: CodegenResult;

    /**
     * The command running the gate. Threaded through so the blocked-drift
     * remediation names only the override flags THAT command accepts — it used
     * to list both unconditionally, and following it verbatim failed on the
     * command that printed it.
     */
    command?: string;

    /** Counts the rows a widened TTL deletes next sweep, for the warning. Present only where a deployment can be read. */
    countExpiringRows?: ExpiringRowCounter;
    logger: Logger;
    readOnly?: boolean;
}): Promise<SchemaDriftGateResult> => {
    const { allowDrift, checkStoredRows, codegen, command, countExpiringRows, logger, readOnly = false } = options;
    const snapshotPath = codegen.schemaSnapshotPath;
    const baseline = readBaseline(snapshotPath);
    const context: GateContext = {
        checkStoredRows,
        command,
        countExpiringRows,
        logger,
        readOnly,
        rebless: () => {
            writeBaseline(snapshotPath, codegen.schemaSnapshot);
        },
        snapshotPath,
    };

    if (baseline.status === "corrupt") {
        return corruptBaselineResult(context);
    }

    const evaluate = (override: boolean): SchemaDriftDecision =>
        evaluateSchemaDrift({
            allowDrift: override,
            baseline: baseline.status === "ok" ? baseline.snapshot : undefined,
            command,
            current: codegen.schemaSnapshot,
            indexReferences: codegen.indexReferences,
            migrations: codegen.migrations,
        });

    const decision = evaluate(allowDrift);

    if (decision.blocked) {
        return blockedDecisionResult(decision, context);
    }

    // `--allow-schema-drift` is a PER-RUN override, not an acceptance of the new
    // shape: re-blessing on its say-so advances the committed baseline past the
    // breaking change, so the very next run — with no flag at all — sees no drift
    // and the gate is disarmed for good. Re-evaluating without the override is how we
    // tell "waved through" from "no breaking drift to wave through"; the diff is pure
    // and in-memory.
    const overriddenOnly = allowDrift && decision.changes.length > 0 && evaluate(false).blocked;

    // Non-blocked drift (safe / migration-accompanied / overridden): surface it
    // and hand back a deferred re-bless so the baseline advances only on success.
    if (decision.changes.length > 0) {
        if (!readOnly) {
            logger.info(decision.reason);
        }

        if (overriddenOnly) {
            return overriddenResult(decision, context);
        }

        await warnAboutProceeding(decision.changes, context);

        return { blocked: false, changes: decision.changes, reason: decision.reason, rebless: readOnly ? undefined : context.rebless };
    }

    return { blocked: false, changes: decision.changes, reason: decision.reason };
};

export type { ExpiringRowCounter, SchemaDriftGateResult, StoredRowChecker };
export { runSchemaDriftGate };
