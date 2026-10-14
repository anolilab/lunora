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

/**
 * Outcome for a blocking decision: log it (unless read-only, where the caller
 * reports), and honor `--update-schema-baseline` by deferring a re-bless to the
 * success path rather than writing inline.
 */
const blockedDecisionResult = (decision: SchemaDriftDecision, context: GateContext): SchemaDriftGateResult => {
    if (!context.readOnly) {
        context.logger.error(decision.reason);
    }

    if (context.updateBaseline && !context.readOnly) {
        context.logger.warn(`schema baseline will be re-blessed despite breaking drift on success (--update-schema-baseline): ${context.snapshotPath}`);

        return { blocked: false, changes: decision.changes, reason: decision.reason, rebless: context.rebless };
    }

    return { blocked: true, changes: decision.changes, reason: decision.reason };
};

const runSchemaDriftGate = (options: {
    allowDrift: boolean;
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
}): SchemaDriftGateResult => {
    const { allowDrift, codegen, command, logger, readOnly = false, updateBaseline = false } = options;
    const snapshotPath = codegen.schemaSnapshotPath;
    const baseline = readBaseline(snapshotPath);
    const context: GateContext = {
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

        if (overriddenOnly && !updateBaseline) {
            if (!readOnly) {
                logger.warn(
                    `schema baseline left at its committed shape — --allow-schema-drift overrides this run only. Pass --update-schema-baseline to accept the new shape: ${snapshotPath}`,
                );
            }

            return { blocked: false, changes: decision.changes, reason: decision.reason };
        }

        return { blocked: false, changes: decision.changes, reason: decision.reason, rebless: readOnly ? undefined : context.rebless };
    }

    return { blocked: false, changes: decision.changes, reason: decision.reason };
};

export type { SchemaDriftGateResult };
export { runSchemaDriftGate };
