import emit from "../../finding";
import type { Lint } from "../../types";

/** Human-readable name for each unrestricted form, used in the finding detail. */
const FORM_LABEL = { "empty-object": "`{}`", undefined: "`undefined`" } as const;

/**
 * Flags a branching `defineShape({ where })` / `definePolicy({ when })` predicate
 * whose arm returns `{}` or `undefined`.
 *
 * A row predicate returns a **filter**, not a boolean. So the denial arm has to be a
 * predicate that matches no rows — `deny()`, i.e. `{ OR: [] }`, a disjunction over
 * zero branches. `{}` is its exact opposite: it matches *every* row. A guard written
 * as `if (ctx.auth.userId !== userId) return {}` therefore does the opposite of what
 * it reads like, replicating the entire table to an unauthorized subscriber — with no
 * error, no log line, and a shape that still appears to work.
 *
 * `undefined` is the same trap one step removed: for a policy `when` it means "opt
 * this policy out" (leaving the table unrestricted by *this* policy), which reads
 * like a denial but isn't one.
 *
 * Only *branching* predicates are flagged. A single-exit `where: () => ({})` is an
 * author deliberately replicating everything, which is a legitimate (if broad) shape.
 * The dangerous pattern is the guard whose deny arm was meant to close the door.
 *
 * Runs only when the codegen feeder supplies the evidence
 * (`context.unrestrictedWhereBranches`); a runtime caller flags nothing. One finding
 * per offending arm.
 */
const unrestrictedWhereBranch: Lint = {
    categories: ["SECURITY"],
    description:
        "A branching `defineShape({ where })` / `definePolicy({ when })` predicate returns `{}` or `undefined` from one arm. A row predicate is a filter, not a boolean: `{}` matches EVERY row, so an arm meant to deny instead replicates or exposes the whole table — silently.",
    facing: "EXTERNAL",
    level: "ERROR",
    name: "unrestricted_where_branch",
    remediation:
        "Return `deny()` (from `@lunora/server`) — or `false`, which compiles to the same vacuously-false `{ OR: [] }` predicate — from the denial arm. Reach for `allowAll()` only when that arm genuinely means 'no further restriction'. For an owner check, prefer `.ownedBy(field)` on the table plus `defineShape({ owner: true })`, which derives the predicate from the verified identity and cannot be written backwards.",
    run: (context) => {
        if (context.unrestrictedWhereBranches === undefined) {
            return [];
        }

        return context.unrestrictedWhereBranches.map((branch) =>
            emit(unrestrictedWhereBranch, {
                cacheKey: `unrestricted_where_branch:${branch.file}:${branch.line.toString()}:${branch.key}`,
                detail:
                    `\`${branch.owner}\` \`${branch.exportName}\` (${branch.file}:${branch.line.toString()}) returns ${FORM_LABEL[branch.form]} from one arm of its \`${branch.key}\` predicate. ` +
                    `A predicate is a filter, not a boolean — ${FORM_LABEL[branch.form]} imposes no restriction, so this arm matches every row instead of none. ` +
                    `Return \`deny()\` (or \`false\`) if it was meant to deny; use \`allowAll()\` to state an intentionally unrestricted arm.`,
                metadata: { exportName: branch.exportName, file: branch.file, form: branch.form, key: branch.key, line: branch.line, owner: branch.owner },
            }),
        );
    },
    source: "static",
    title: "Predicate arm returns an unrestricted filter",
};

export default unrestrictedWhereBranch;
