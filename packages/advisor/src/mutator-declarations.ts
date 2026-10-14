/**
 * One exported `defineMutator({ … })` declaration in `lunora/mutators.ts` — the
 * input the `mutator_without_owner_scope` lint consumes.
 *
 * A custom mutator is a **write endpoint any client can call**: the optimistic
 * client half pushes straight through `client.callMutator`, and the DO runs the
 * authoritative `server` impl as the linearization point. `owner` is the
 * declarative scope that makes that safe — it requires a verified identity,
 * rejects a client-supplied owner that disagrees with it, and stamps the column
 * with the verified value, so the impl can read `args[owner]` without trusting
 * the client.
 *
 * `defineShape` *refuses at registration* when nothing scopes it, because an
 * unscoped shape replicates the whole table. A mutator that declares no `owner`
 * cannot refuse the same way — writing rows nobody owns, or authorizing by hand
 * in the impl, are both legitimate — so the asymmetry is reported here instead
 * of thrown. Produced by the codegen feeder; runtime callers don't supply it, so
 * the lint finds nothing there.
 */
export interface AdvisorMutatorDeclaration {
    /** The mutator's export binding name (e.g. `createPost`). */
    exportName: string;
    /** Openable source path the declaration appears in — always `lunora/mutators.ts`. */
    file: string;
    /** 1-based line of the `defineMutator(...)` call, or `0` when unknown. */
    line: number;

    /**
     * The ownership column the declaration scopes the write to, or `undefined`
     * when it declares none — which is what the lint reports. A computed (non
     * string-literal) `owner` also reads as `undefined`: the feeder cannot
     * resolve it, and treating it as scoped would fake a guarantee.
     */
    owner?: string;
}
