import type { Node } from "ts-morph";

import { wrappedCallsInChain } from "../ast";

/**
 * True when the builder chain rooted at `receiver` carries a
 * `.<method>(<wrappedCallee>(...))` step — e.g. `.use(mask(...))` or `.use(rls(...))`.
 *
 * Shares `wrappedCallsInChain` with `rlsCallsInChain` / `maskCallsInChain` so all
 * three answer the same question the same way. They had drifted: those two
 * resolved an import alias and this one compared callee text, so under
 * `import { rls as rowLevel }` a procedure read `usesRls: true` to
 * `discoverRlsProcedures` and `usesRls: false` to the feeders built on this.
 */
const chainUsesWrappedCall = (receiver: Node, method: string, wrappedCallee: string): boolean =>
    wrappedCallsInChain(receiver, method, wrappedCallee).length > 0;

export default chainUsesWrappedCall;
