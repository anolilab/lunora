import type { CallExpression, Node as TsNode } from "ts-morph";
import { Node } from "ts-morph";

import { resolvesToImportedName, wrappedCallsInChain } from "../../ast";

/**
 * True when `node` is a `CallExpression` whose callee resolves to the name
 * `"rls"` — a bare identifier (`rls(policies)`), a property access
 * (`rlsModule.rls(policies)`), or an import alias (`import { rls as rowLevel }`
 * called as `rowLevel(policies)`). Matched by name rather than import origin so
 * the check is robust even when ts-morph has degraded type info; see
 * `resolvesToImportedName` for why the alias hop is additive to that.
 */
const isRlsCall = (node: TsNode): boolean => Node.isCallExpression(node) && resolvesToImportedName(node.getExpression(), "rls");

/**
 * Every `rls(...)` call carried through a `.use(rls(...))` step of the builder
 * chain rooted at `receiver`, terminal-first. Shares the chain walk with the
 * mask twin and with `chainUsesWrappedCall`, so all three agree on aliases and
 * on seeing through a `(…)` / `as T` wrapper mid-chain.
 */
const rlsCallsInChain = (receiver: TsNode): CallExpression[] => wrappedCallsInChain(receiver, "use", "rls");

export { isRlsCall, rlsCallsInChain };
