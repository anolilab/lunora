import type { CallExpression, Node as TsNode, ObjectLiteralExpression } from "ts-morph";
import { Node } from "ts-morph";

import { isConstDeclaration, unwrapExpression } from "../../ast";
import { resolvesToImportedName } from "../../callee";

/**
 * Follow one same-file `const` hop: an identifier becomes its `const` initializer,
 * anything else is returned unwrapped. A `let`, an import, or a parameter is not
 * followed, because its value can differ from the one the initializer shows.
 */
const onePlaceHop = (node: TsNode | undefined): TsNode | undefined => {
    const unwrapped = unwrapExpression(node);

    if (!unwrapped || !Node.isIdentifier(unwrapped)) {
        return unwrapped;
    }

    const declaration = unwrapped.getSourceFile().getVariableDeclaration(unwrapped.getText());

    return isConstDeclaration(declaration) ? unwrapExpression(declaration.getInitializer()) : undefined;
};

/** The argument of a `definePolicies(<x>)` call; any other node is returned as is. */
const unwrapDefinePolicies = (node: TsNode | undefined): TsNode | undefined => {
    if (node && Node.isCallExpression(node) && resolvesToImportedName(node.getExpression(), "definePolicies")) {
        return node.getArguments()[0];
    }

    return node;
};

/** The policy object a list element denotes: an object literal, or the object passed to `definePolicy(...)`. */
const policyObjectOf = (node: TsNode | undefined): ObjectLiteralExpression | undefined => {
    if (node && Node.isObjectLiteralExpression(node)) {
        return node;
    }

    if (node && Node.isCallExpression(node) && resolvesToImportedName(node.getExpression(), "definePolicy")) {
        const argument = unwrapExpression(node.getArguments()[0]);

        return argument && Node.isObjectLiteralExpression(argument) ? argument : undefined;
    }

    return undefined;
};

/**
 * The policy object literals an `rls(...)` call declares, read statically. The
 * argument may be an inline array, a `definePolicies([...])` call, or a same-file
 * `const` bound to either. Each element may be an object literal, a
 * `definePolicy({...})` call, or a same-file `const` bound to either. Anything
 * else (a function call, an imported list) yields nothing: its policies cannot be
 * enumerated here, so they are skipped rather than guessed.
 */
const policyObjectLiterals = (rlsCall: CallExpression): ObjectLiteralExpression[] => {
    const list = unwrapDefinePolicies(onePlaceHop(rlsCall.getArguments()[0]));

    if (!list || !Node.isArrayLiteralExpression(list)) {
        return [];
    }

    const objects: ObjectLiteralExpression[] = [];

    for (const element of list.getElements()) {
        const object = policyObjectOf(onePlaceHop(element));

        if (object) {
            objects.push(object);
        }
    }

    return objects;
};

export default policyObjectLiterals;
