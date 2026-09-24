import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a custom mutator that declares no `owner` scope.
 *
 * A mutator is a **write endpoint any client can call**: `bindMutators` pushes
 * the optimistic half straight through `client.callMutator`, and the DO runs the
 * authoritative `server` impl as the linearization point. `owner` is the
 * declarative scope that ties each write to its caller — before `server` runs it
 * requires a verified identity, rejects a client-supplied owner that disagrees
 * with it, and stamps the column with the verified value, so the impl reads
 * `args[owner]` without trusting the client.
 *
 * Without it the mutator authorizes nothing by itself: an anonymous caller
 * reaches it, and any row it names is fair game unless the impl checks by hand.
 * `defineShape` refuses at registration when nothing scopes it — an unscoped
 * shape would replicate the whole table — and this is the missing write-side
 * half of that symmetry.
 *
 * `WARN`, not `ERROR`, and not a registration-time throw: a mutator that writes
 * rows nobody owns (a counter, an append-only log), one whose `server` impl does
 * its own authorization, and one reached only through a trusted server path are
 * all legitimate. The lint surfaces the unscoped endpoint so the choice is made
 * deliberately rather than by omission.
 *
 * **Evidence supply**: runs only when the codegen feeder supplies
 * `context.mutators`; absent for runtime callers, where the lint finds nothing.
 * A computed (non string-literal) `owner` reads as unscoped — the feeder cannot
 * resolve it, and treating it as scoped would fake the guarantee.
 */
const mutatorWithoutOwnerScope: Lint = {
    categories: ["SECURITY"],
    description:
        "A custom mutator declares no `owner` scope. Mutators are client-callable write endpoints, and `owner` is what ties each write to its caller's verified identity — without it the mutator authorizes nothing by itself.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "mutator_without_owner_scope",
    remediation:
        'Add `owner: "<column>"` to the `defineMutator({ … })` declaration — it requires a verified identity, rejects a client-supplied owner that disagrees with it, and stamps the column with the verified value. If the write genuinely owns no row, or the `server` impl authorizes by hand, leave it and treat this as acknowledged.',
    run: (context) => {
        if (context.mutators === undefined) {
            return [];
        }

        return context.mutators
            .filter((mutator) => mutator.owner === undefined)
            .map((mutator) =>
                emit(mutatorWithoutOwnerScope, {
                    cacheKey: `mutator_without_owner_scope:${mutator.file}:${mutator.exportName}`,
                    detail: `Mutator \`${mutator.exportName}\` (${mutator.file}:${String(mutator.line)}) declares no \`owner\`, so any client that can reach the endpoint can write through it and nothing ties the write to the caller's identity. Add \`owner: "<column>"\`, or authorize explicitly in the \`server\` impl.`,
                    metadata: { exportName: mutator.exportName, file: mutator.file, line: mutator.line },
                }),
            );
    },
    source: "static",
    title: "Custom mutator has no owner scope",
};

export default mutatorWithoutOwnerScope;
