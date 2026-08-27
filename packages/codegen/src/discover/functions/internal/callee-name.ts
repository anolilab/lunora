import { Node } from "ts-morph";

/** The simple name of a call's callee — a bare identifier's text or a property access's member name, else `""`. */
const calleeName = (callee: Node): string => {
    if (Node.isIdentifier(callee)) {
        return callee.getText();
    }

    return Node.isPropertyAccessExpression(callee) ? callee.getName() : "";
};

export default calleeName;
