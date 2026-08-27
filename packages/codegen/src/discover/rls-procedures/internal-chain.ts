import type { CallExpression, Node as TsNode } from "ts-morph";
import { Node } from "ts-morph";

import { resolvesToImportedName, unwrapExpression } from "../ast";

/**
 * True when `node` is a `CallExpression` whose callee resolves to the name
 * `"rls"` — a bare identifier (`rls(policies)`), a property access
 * (`rlsModule.rls(policies)`), or an import alias (`import { rls as rowLevel }`
 * called as `rowLevel(policies)`). Matched by name rather than import origin so
 * the check is robust even when ts-morph has degraded type info; see
 * `resolvesToImportedName` for why the alias hop is additive to that.
 */
const isRlsCall = (node: TsNode): boolean => {
    if (!Node.isCallExpression(node)) {
        return false;
    }

    return resolvesToImportedName(node.getExpression(), "rls");
};

/**
 * Walk a builder chain leftward from `receiver` (the expression to the left of the
 * terminal `.query(...)` / `.mutation(...)` call) and collect every `rls(...)`
 * `CallExpression` it carries through a `.use(rls(...))` step. The single source of
 * truth for the chain shape; the lint (`rlsFromBuilderChain`) and the studio
 * inspector metadata (`rlsMetadataFromChain`) each layer their own extraction
 * over the same walk, so the chain-recognition invariant lives in one place.
 *
 * Structure recognised (leftward) — in `c.use(rls([...])).query(handler)` the
 * `c.use(rls([...]))` portion is the receiver and `.query(handler)` is terminal.
 * The chain is a nested `CallExpression` tree; each step is a `CallExpression` whose
 * callee is a `PropertyAccessExpression` (the builder method `.use`/`.input`/… and
 * its argument). A `.use(rls(...))` step is the property name `"use"` with a first
 * argument that is an `rls(...)` call (callee an identifier/property named `"rls"`).
 */
const rlsCallsInChain = (receiver: TsNode): CallExpression[] => {
    const calls: CallExpression[] = [];
    let node: TsNode | undefined = unwrapExpression(receiver);

    while (node && Node.isCallExpression(node)) {
        const chainCallee = node.getExpression();

        if (!Node.isPropertyAccessExpression(chainCallee)) {
            break;
        }

        if (chainCallee.getName() === "use") {
            const argument = node.getArguments()[0];

            if (argument && isRlsCall(argument)) {
                calls.push(argument as CallExpression);
            }
        }

        node = unwrapExpression(chainCallee.getExpression());
    }

    return calls;
};

export { isRlsCall, rlsCallsInChain };
