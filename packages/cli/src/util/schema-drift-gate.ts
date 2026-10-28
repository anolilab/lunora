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
 * never block), `updateBaseline` (re-bless the baseline even on a blocked
 * outcome, deliberately accepting the new shape), and `readOnly` (evaluate +
 * report but never write — used by `lunora verify`).
 *
 * The returned `rebless` thunk (when present) is the ONLY baseline write — the
 * caller invokes it on success so a failed deploy never advances the baseline.
 */
interface GateContext {
    checkStoredRows?: StoredRowChecker;
    command?: string;
    logger: Logger;
    readOnly: boolean;
    rebless: () => void;
    snapshotPath: string;
    updateBaseline: boolean;
}

/**
 * Outcome for a present-but-corrupt baseline: block (so drift isn't silently
 * skipped and the bad file isn't auto-overwritten) unless the developer opts
 * into regenerating it from the current schema.
 */
const corruptBaselineResult = (context: GateContext): SchemaDriftGateResult => {
    const reason =
        `schema-drift gate: the committed baseline ${context.snapshotPath} is unreadable or malformed, so schema drift cannot be checked. ` +
        `Fix it (e.g. resolve a merge conflict in lunora/.lunora-schema.json), or pass --update-schema-baseline to regenerate it from the current schema.`;

    if (context.updateBaseline && !context.readOnly) {
        context.logger.warn(
            `schema baseline was unreadable; regenerating from the current schema on success (--update-schema-baseline): ${context.snapshotPath}`,
        );

        return { blocked: false, changes: [], reason, rebless: context.rebless };
    }

    // Read-only callers (verify) own the reporting — staying silent here avoids
    // the message being logged twice.
    if (!context.readOnly) {
        context.logger.error(reason);
    }

    return { blocked: true, changes: [], reason };
};

/** `logger` with errors demoted to warnings, for a check whose failure does not stop the run. */
const quietLogger = (logger: Logger): Logger => {
    return {
        ...logger,
        error: (message) => {
            logger.warn(message);
        },
    };
};

/**
 * Both `--allow-schema-drift` and `--update-schema-baseline`: the run goes ahead
 * either way, but the shape is accepted only past the stored-row check a plain
 * `--update-schema-baseline` runs, or the pair would bless unchecked what the
 * second flag alone refuses.
 */
const acceptCheckedShape = async (overridden: SchemaDriftDecision, strict: SchemaDriftDecision, context: GateContext): Promise<SchemaDriftGateResult> => {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- the strict decision is judged exactly as a blocked run would be
    const checked = await blockedDecisionResult(strict, { ...context, logger: quietLogger(context.logger) });

    if (checked.blocked) {
        context.logger.warn(
            `schema baseline left at its committed shape — the stored rows do not confirm the new shape, so only --allow-schema-drift applies to this run: ${context.snapshotPath}`,
        );

        return { blocked: false, changes: overridden.changes, reason: `${overridden.reason}\n\n${checked.reason}` };
    }

    return { blocked: false, changes: overridden.changes, reason: overridden.reason, rebless: context.rebless };
};

/** A run `--allow-schema-drift` let through: the baseline stays put unless `--update-schema-baseline` asks and the rows confirm it. */
const overriddenResult = async (overridden: SchemaDriftDecision, strict: SchemaDriftDecision, context: GateContext): Promise<SchemaDriftGateResult> => {
    if (context.readOnly) {
        return { blocked: false, changes: overridden.changes, reason: overridden.reason };
    }

    if (context.updateBaseline) {
        return acceptCheckedShape(overridden, strict, context);
    }

    context.logger.warn(
        `schema baseline left at its committed shape — --allow-schema-drift overrides this run only. Pass --update-schema-baseline to accept the new shape: ${context.snapshotPath}`,
    );

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
 * Read the stored rows when they can decide the outcome: every blocking change is
 * one rows decide, or `--update-schema-baseline` asks to accept the shape and some
 * of it is. A command with no deployment to read (`prepare`, `build`) answers
 * "inconclusive" for an acceptance, so it can never bless a shape unchecked.
 */
const storedRowVerdict = async (decision: SchemaDriftDecision, context: GateContext): Promise<StoredRowVerdict | undefined> => {
    const checkable = decision.uncovered.filter((change) => isRowCheckable(change));
    const decisive = checkable.length > 0 && (checkable.length === decision.uncovered.length || context.updateBaseline);

    if (!decisive || context.readOnly) {
        return undefined;
    }

    if (context.checkStoredRows === undefined) {
        return context.updateBaseline
            ? {
                  kind: "inconclusive",
                  reason: `\`lunora ${context.command ?? "prepare"}\` does not read a deployment; run \`lunora deploy --update-schema-baseline\`, which checks the stored rows first`,
              }
            : undefined;
    }

    return context.checkStoredRows(checkable);
};

/**
 * Outcome for a blocking decision. Stored rows that all fit the new schema clear
 * it — the shape is then simply true of the data, so the baseline advances on
 * success. `--update-schema-baseline` accepts the shape, but never over rows
 * that contradict it or could not be checked; changes rows cannot decide (an
 * index, a call site, a constraint) it accepts on the operator's word, as before.
 */
const blockedDecisionResult = async (decision: SchemaDriftDecision, context: GateContext): Promise<SchemaDriftGateResult> => {
    const verdict = await storedRowVerdict(decision, context);
    const accepted = { blocked: false, changes: decision.changes, reason: decision.reason, rebless: context.rebless };

    if (verdict?.kind === "conforms") {
        context.logger.success(
            `schema-drift gate: all ${String(verdict.rows)} stored row(s) of ${verdict.tables.join(", ")} fit the new schema — the change needs no backfill`,
        );

        if (context.updateBaseline && decision.uncovered.some((change) => !isRowCheckable(change))) {
            context.logger.warn(
                `schema baseline will be re-blessed with changes the stored rows cannot confirm (--update-schema-baseline): ${context.snapshotPath}`,
            );
        }

        return accepted;
    }

    const refusesAcceptance = verdict !== undefined && context.updateBaseline;
    const reason = `${decision.reason}${verdictNote(verdict)}${refusesAcceptance ? "\n\n--update-schema-baseline does not accept a shape the stored rows contradict or that could not be checked." : ""}`;

    if (!context.readOnly) {
        context.logger.error(reason);
    }

    if (context.updateBaseline && !context.readOnly && !refusesAcceptance) {
        context.logger.warn(`schema baseline will be re-blessed despite breaking drift on success (--update-schema-baseline): ${context.snapshotPath}`);

        return { ...accepted, reason };
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
    logger: Logger;
    readOnly?: boolean;
    updateBaseline?: boolean;
}): Promise<SchemaDriftGateResult> => {
    const { allowDrift, checkStoredRows, codegen, command, logger, readOnly = false, updateBaseline = false } = options;
    const snapshotPath = codegen.schemaSnapshotPath;
    const baseline = readBaseline(snapshotPath);
    const context: GateContext = {
        checkStoredRows,
        command,
        logger,
        readOnly,
        rebless: () => {
            writeBaseline(snapshotPath, codegen.schemaSnapshot);
        },
        snapshotPath,
        updateBaseline,
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
            migrations: codegen.migrations,
        });

    const decision = evaluate(allowDrift);

    if (decision.blocked) {
        return blockedDecisionResult(decision, context);
    }

    // `--allow-schema-drift` is a PER-RUN override, not an acceptance of the new
    // shape: re-blessing on its say-so advances the committed baseline past the
    // breaking change, so the very next run — with no flag at all — sees no drift
    // and the gate is disarmed for good. `prepare` makes that starkest (it
    // produces no bundle, so nothing shipped), but the same write from `deploy`
    // means the flag and `--update-schema-baseline` do the same thing. Only the
    // latter accepts the shape. Re-evaluating without the override is how we tell
    // "waved through" from "no breaking drift to wave through"; the diff is pure
    // and in-memory.
    const overriddenOnly = allowDrift && decision.changes.length > 0 && evaluate(false).blocked;

    // Non-blocked drift (safe / migration-accompanied / overridden): surface it
    // and hand back a deferred re-bless so the baseline advances only on success.
    if (decision.changes.length > 0) {
        if (!readOnly) {
            logger.info(decision.reason);
        }

        if (overriddenOnly) {
            return overriddenResult(decision, evaluate(false), context);
        }

        return { blocked: false, changes: decision.changes, reason: decision.reason, rebless: readOnly ? undefined : context.rebless };
    }

    return { blocked: false, changes: decision.changes, reason: decision.reason };
};

export type { SchemaDriftGateResult, StoredRowChecker };
export { runSchemaDriftGate };
