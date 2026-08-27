import type { CallExpression } from "ts-morph";
import { Node } from "ts-morph";

import type { ValidatorIR } from "../../../ir";
import { parseObjectShape, parseValidator } from "../../../parse-validator";
import unwrapHandlerReturn from "../unwrap-handler-return";

/**
 * Pull the handler's return type out of an object-literal `query/mutation/action`
 * call (the `{ args, handler }` form).
 */
const returnTypeFromCall = (call: CallExpression): string => {
    const first = call.getArguments()[0];

    if (!first || !Node.isObjectLiteralExpression(first)) {
        return "unknown";
    }

    const handlerProperty = first.getProperty("handler");

    if (!handlerProperty || !Node.isPropertyAssignment(handlerProperty)) {
        return "unknown";
    }

    const initializer = handlerProperty.getInitializer();

    if (!initializer || !(Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
        return "unknown";
    }

    return unwrapHandlerReturn(initializer);
};

/**
 * Pull the handler's return type out of a builder terminal call. Here the
 * handler is the first (and only) argument — `c.query(({ ctx, args }) => …)` —
 * not a `handler:` property.
 */
const returnTypeFromBuilderCall = (call: CallExpression): string => {
    const handler = call.getArguments()[0];

    if (!handler || !(Node.isArrowFunction(handler) || Node.isFunctionExpression(handler))) {
        return "unknown";
    }

    return unwrapHandlerReturn(handler);
};

/**
 * Walk a builder chain leftward from the terminal receiver, merging every
 * `.input({...})` argument into one args record. Chains read terminal → root,
 * so a key set by a later `.input()` (encountered first) must win over an
 * earlier one — hence `{ ...earlier, ...merged }`, mirroring the runtime's
 * `{ ...state.args, ...validators }` spread order.
 */
const argsFromBuilderChain = (receiver: Node): Record<string, ValidatorIR> => {
    let merged: Record<string, ValidatorIR> = {};
    let node: Node = receiver;

    while (Node.isCallExpression(node)) {
        const chainCallee = node.getExpression();

        if (!Node.isPropertyAccessExpression(chainCallee)) {
            break;
        }

        if (chainCallee.getName() === "input") {
            const argument = node.getArguments()[0];

            if (argument && Node.isObjectLiteralExpression(argument)) {
                merged = { ...parseObjectShape(argument), ...merged };
            }
        }

        node = chainCallee.getExpression();
    }

    return merged;
};

/**
 * The `.output(validator)` declaration on a builder chain, if any.
 *
 * Walks leftward like {@link argsFromBuilderChain}. Chains read terminal → root,
 * so the FIRST `.output()` encountered is the LAST one written, which is the one
 * that wins at runtime (each `.output()` replaces the previous).
 */
const outputFromBuilderChain = (receiver: Node): ValidatorIR | undefined => {
    let node: Node = receiver;

    while (Node.isCallExpression(node)) {
        const chainCallee = node.getExpression();

        if (!Node.isPropertyAccessExpression(chainCallee)) {
            return undefined;
        }

        if (chainCallee.getName() === "output") {
            const argument = node.getArguments()[0];

            return argument && Node.isExpression(argument) ? parseValidator(argument) : undefined;
        }

        node = chainCallee.getExpression();
    }

    return undefined;
};

export { argsFromBuilderChain, outputFromBuilderChain, returnTypeFromBuilderCall, returnTypeFromCall };
