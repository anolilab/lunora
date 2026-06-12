/**
 * Pre-deploy schema-drift gate.
 *
 * Reads the committed structural baseline (`cirrus/.cirrus-schema.json`),
 * compares it against the snapshot codegen produced this run, and decides
 * whether breaking drift without an accompanying data migration should block
 * the deploy. The pure diff/classify/decision logic lives in `@cirrus/codegen`
 * (`evaluateSchemaDrift`); this module is the thin I/O + logging shell the
 * deploy / verify / prepare commands call, mirroring the D1-placeholder guard.
 *
 * On a passing (non-blocked) run that DID drift, the baseline is re-blessed with
 * the current snapshot so the next run measures against the just-shipped shape.
 * A clean run (no drift) leaves the file untouched.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { CodegenResult, SchemaDriftDecision } from "@cirrus/codegen";
import { evaluateSchemaDrift, parseSchemaSnapshot, serializeSchemaSnapshot } from "@cirrus/codegen";

import type { Logger } from "./logger";

/** Read + parse the committed baseline, or `undefined` when absent/unreadable/wrong-version. */
const readBaseline = (snapshotPath: string): ReturnType<typeof parseSchemaSnapshot> => {
    if (!existsSync(snapshotPath)) {
        return undefined;
    }

    try {
        return parseSchemaSnapshot(readFileSync(snapshotPath, "utf8"));
    } catch {
        return undefined;
    }
};

/** The structured outcome a command embeds in its `--format json` result + uses for exit code. */
interface SchemaDriftGateResult {
    /** True when the deploy must be aborted with a non-zero exit. */
    blocked: boolean;
    /** Per-change classification (both severities), for machine-readable output. */
    changes: SchemaDriftDecision["changes"];
    /** The actionable explanation, empty string when there was no drift. */
    reason: string;
}

/**
 * Run the schema-drift gate against the snapshot codegen produced. `options`
 * carries `codegen` (this run's `CodegenResult`, with the current snapshot +
 * baseline path), `allowDrift` (the `--allow-schema-drift` override — report but
 * never block), `updateBaseline` (re-bless the baseline even on a blocked
 * outcome, deliberately accepting the new shape), and `readOnly` (evaluate +
 * report but never write — used by `cirrus verify`).
 */
const runSchemaDriftGate = (options: {
    allowDrift: boolean;
    codegen: CodegenResult;
    logger: Logger;
    readOnly?: boolean;
    updateBaseline?: boolean;
}): SchemaDriftGateResult => {
    const { allowDrift, codegen, logger, readOnly = false, updateBaseline = false } = options;
    const baseline = readBaseline(codegen.schemaSnapshotPath);

    const decision = evaluateSchemaDrift({ allowDrift, baseline, current: codegen.schemaSnapshot });

    if (decision.blocked) {
        // Mirror the D1-placeholder guard: log the full actionable message, then
        // return a structured result the caller turns into exit code 1.
        logger.error(decision.reason);

        // An explicit `--update-schema-baseline` overrides the block by accepting
        // the new shape into the baseline (the developer asserts they handled it).
        if (updateBaseline && !readOnly) {
            writeFileSync(codegen.schemaSnapshotPath, serializeSchemaSnapshot(codegen.schemaSnapshot), "utf8");
            logger.warn(`schema baseline re-blessed despite breaking drift (--update-schema-baseline): ${codegen.schemaSnapshotPath}`);

            return { blocked: false, changes: decision.changes, reason: decision.reason };
        }

        return { blocked: true, changes: decision.changes, reason: decision.reason };
    }

    // Non-blocked: surface any (safe / migration-accompanied / overridden) drift,
    // then re-bless the baseline so the next run compares against this shape.
    if (decision.changes.length > 0) {
        logger.info(decision.reason);

        if (!readOnly) {
            writeFileSync(codegen.schemaSnapshotPath, serializeSchemaSnapshot(codegen.schemaSnapshot), "utf8");
            logger.success(`schema baseline updated: ${codegen.schemaSnapshotPath}`);
        }
    }

    return { blocked: false, changes: decision.changes, reason: decision.reason };
};

export type { SchemaDriftGateResult };
export { runSchemaDriftGate };
