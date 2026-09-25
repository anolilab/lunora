import type { ValidatorIR } from "./ir";

/**
 * Whether a procedure's declared `.output(validator)` — rather than its handler's
 * inferred return type — is what the emitted `FunctionReference` carries.
 *
 * `emit.ts`'s `referenceReturnType` renders from this, and discovery asks it
 * before reporting a handler return that erased to `unknown`: an erasure the
 * declared output replaces never reaches `_generated/`, so reporting it would
 * name a type that is not in the output and prescribe `.output(...)` as a fix
 * that is already applied. One predicate for both, so they cannot drift.
 *
 * `{ kind: "any" }` is what `parseValidator` yields for any non-call expression,
 * including the ordinary `.output(sharedValidator)`; preferring that would
 * replace a precise inferred type with `unknown`. A `stream` keeps its handler's
 * type because `.output()` is inert on that terminal.
 */
const declaredOutputWins = <T extends { kind: string; output?: ValidatorIR }>(definition: T): definition is T & { output: ValidatorIR } =>
    definition.output !== undefined && definition.output.kind !== "any" && definition.kind !== "stream";

export default declaredOutputWins;
