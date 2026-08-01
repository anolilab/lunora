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
 *
 * `fact` rather than a precomputed boolean: `classifySensitivity` below needs
 * to tell a proven `true` apart from an `undefined` (unreadable) fact, because
 * only the former licenses the specific "writes an identity table" style claim.
 */
const SIGNALS: ReadonlyArray<{ fact: (procedure: AdvisorProcedureProtection) => boolean | undefined; reason: string }> = [
    { fact: (procedure) => procedure.writesUserTable, reason: "writes an identity table" },
    { fact: (procedure) => procedure.callsMail, reason: "sends mail" },
    { fact: (procedure) => procedure.fanOut, reason: "fans out to a privileged dispatch surface" },
    { fact: (procedure) => procedure.usesInsertManyUnsafe, reason: "bypasses validators with insertManyUnsafe" },
    { fact: (procedure) => procedure.unboundedAiGeneration, reason: "runs an unbounded AI generation" },
];

/** The shared reason for an `undefined` fact — never a specific unproven behavioural claim. */
const UNREADABLE_HANDLER_REASON = "may exhibit sensitive behaviour — its handler body could not be read";

/**
 * Classify how much a procedure's failures matter, from the protective
 * declarations and behavioural facts the feeder already collected.
 *
 * Runs before any rule so a lint can gate on it, and feeds the global weighting:
 * a handler touching identity, mail, or tenant-scoped rows pulls harder on the
 * grade than a plain read. `none` means no signal fired — not "safe".
 *
 * A fact reads `undefined` only when the feeder couldn't read the handler body
 * (a cross-file handler, or — degenerately — a partial payload), and that stays
 * fail-closed: `level` goes `"high"` the same as a proven `true` would. The
 * reason text does not, though — asserting "writes an identity table" for a
 * fact that was never observed would misattribute an unproven claim. A proven
 * `true` still gets its specific reason; every `undefined` fact collapses into
 * one shared "could not be read" reason instead of one unproven claim apiece.
 */
const classifySensitivity = (procedure: AdvisorProcedureProtection): Sensitivity => {
    const reasons: string[] = [];
    let hasUnreadableSignal = false;

    for (const signal of SIGNALS) {
        const fact = signal.fact(procedure);

        if (fact === true) {
            reasons.push(signal.reason);
        } else if (fact === undefined) {
            hasUnreadableSignal = true;
        }
    }

    if (hasUnreadableSignal) {
        reasons.push(UNREADABLE_HANDLER_REASON);
    }

    const level: SensitivityLevel = reasons.length === 0 ? "none" : "high";

    return { level, reasons };
};

export default classifySensitivity;
