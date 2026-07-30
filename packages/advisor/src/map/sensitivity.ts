import type { AdvisorProcedureProtection } from "../procedure-protections";
import type { Sensitivity, SensitivityLevel } from "./types";

/**
 * Facts that mark a procedure as handling something worth extra care, mapped to
 * the reason surfaced in the artifact.
 *
 * Each is a *declaration the developer already made* rather than a guess: a
 * procedure that installs `rls()` is telling us the rows are tenant-scoped, one
 * that installs `mask()` is telling us columns are sensitive, and one the feeder
 * saw writing a user/session/account table is handling identity. That keeps the
 * classification defensible — it never infers sensitivity from a name.
 */
const SIGNALS: ReadonlyArray<{ reason: string; test: (procedure: AdvisorProcedureProtection) => boolean }> = [
    { reason: "writes an identity table", test: (procedure) => procedure.writesUserTable },
    { reason: "sends mail", test: (procedure) => procedure.callsMail },
    { reason: "fans out to a privileged dispatch surface", test: (procedure) => procedure.fanOut },
    { reason: "bypasses validators with insertManyUnsafe", test: (procedure) => procedure.usesInsertManyUnsafe },
    { reason: "runs an unbounded AI generation", test: (procedure) => procedure.unboundedAiGeneration },
];

/**
 * Classify how much a procedure's failures matter, from the protective
 * declarations and behavioural facts the feeder already collected.
 *
 * Runs before any rule so a lint can gate on it, and feeds the global weighting:
 * a handler touching identity, mail, or tenant-scoped rows pulls harder on the
 * grade than a plain read. `none` means no signal fired — not "safe".
 */
const classifySensitivity = (procedure: AdvisorProcedureProtection): Sensitivity => {
    const reasons: string[] = [];

    for (const signal of SIGNALS) {
        if (signal.test(procedure)) {
            reasons.push(signal.reason);
        }
    }

    const level: SensitivityLevel = reasons.length === 0 ? "none" : "high";

    return { level, reasons };
};

export default classifySensitivity;
