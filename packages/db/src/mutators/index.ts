/**
 * `@lunora/db/mutators` — the client-side custom-mutator runtime: `defineMutator`
 * (declare an optimistic body + its authoritative server impl) and `bindMutators`
 * (run the optimistic transaction + push the server write over the watermark
 * protocol). Kept on its own subpath so read-only apps don't pull it in.
 */
export type { BindMutatorsContext, BoundMutators, ClientMutatorContext, ClientMutatorDef } from "../define-mutators";
export { bindMutators, defineMutator } from "../define-mutators";
