import { Node } from "ts-morph";

import { unwrapExpression } from "../ast";

/** True when the builder chain rooted at `receiver` carries a step whose method name is `method` (`.output(...)` / `.use(...)`). */
const chainHasStep = (receiver: Node, method: string): boolean => {
    let node: Node | undefined = unwrapExpression(receiver);

    while (node && Node.isCallExpression(node)) {
        const callee = node.getExpression();

        if (!Node.isPropertyAccessExpression(callee)) {
            break;
        }

        if (callee.getName() === method) {
            return true;
        }

        node = unwrapExpression(callee.getExpression());
    }

    return false;
};

export default chainHasStep;
