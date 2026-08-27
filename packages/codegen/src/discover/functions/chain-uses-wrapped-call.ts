import { Node } from "ts-morph";

import { unwrapExpression } from "../ast";
import calleeName from "./internal/callee-name";

/**
 * True when the builder chain rooted at `receiver` carries a
 * `.<method>(<wrappedCallee>(...))` step — a `.<method>(...)` whose first argument
 * is a call to `wrappedCallee` (e.g. `.use(mask(...))` or `.use(rls(...))`).
 */
const chainUsesWrappedCall = (receiver: Node, method: string, wrappedCallee: string): boolean => {
    let node: Node | undefined = unwrapExpression(receiver);

    while (node && Node.isCallExpression(node)) {
        const callee = node.getExpression();

        if (!Node.isPropertyAccessExpression(callee)) {
            break;
        }

        const argument = node.getArguments()[0];

        if (
            callee.getName() === method &&
            argument !== undefined &&
            Node.isCallExpression(argument) &&
            calleeName(argument.getExpression()) === wrappedCallee
        ) {
            return true;
        }

        node = unwrapExpression(callee.getExpression());
    }

    return false;
};

export default chainUsesWrappedCall;
