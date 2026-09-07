import type { CallExpression, Node as TsNode, ObjectLiteralExpression } from "ts-morph";
import { Node } from "ts-morph";

import { resolveObjectLiteral } from "./parse-validator";

/**
 * The argument declarations of one procedure, as read off its registration.
 *
 * Both registration forms are covered: the builder chain's `.input({...})` steps
 * and a bare factory's `args:` property. `opaque` records that some declaration
 * could not be read statically — a `.input(schema)` naming a shared validator, an
 * `args` initialised from a variable, or a `{ ...spread }` inside the literal.
 * Callers that gate a security lint on "this procedure has no such argument" must
 * treat `opaque` as unknown rather than as absence.
 */
interface ProcedureArgumentObjects {
    /** Every statically-readable object literal declaring args. */
    objects: ObjectLiteralExpression[];
    /** `true` when at least one declaration could not be read (non-literal, or spread-bearing). */
    opaque: boolean;
}

/**
 * True when an object literal carries a `...spread` whose fields cannot be read,
 * making its key set unknowable.
 *
 * A spread that RESOLVES is not opaque: `parseObjectShape` merges its fields, so
 * the keys are enumerable and every consumer — this file's security lints
 * included — can see them. Only the unreadable remainder is unknown, and calling
 * that opaque is what keeps `hasEmailArg`-style checks answering "unknown"
 * instead of "absent". Recurses, because a resolved spread can itself spread
 * something unreadable.
 */
const hasUnreadableSpread = (object: ObjectLiteralExpression, visited: Set<ObjectLiteralExpression> = new Set()): boolean => {
    if (visited.has(object)) {
        return false;
    }

    visited.add(object);

    return object.getProperties().some((property) => {
        if (!Node.isSpreadAssignment(property)) {
            return false;
        }

        const resolved = resolveObjectLiteral(property.getExpression());

        return resolved === undefined || hasUnreadableSpread(resolved, visited);
    });
};

/**
 * The `args:` object literal of a bare-factory `query({ args, handler })` call.
 * Returns `opaque` when the call carries an `args` property that isn't a literal
 * (so its keys are unknown), and a plain empty result when it declares none.
 */
const argumentsOfFactory = (call: CallExpression): ProcedureArgumentObjects => {
    const first = call.getArguments()[0];

    if (!first || !Node.isObjectLiteralExpression(first)) {
        return { objects: [], opaque: true };
    }

    const argumentsProperty = first.getProperty("args");

    if (!argumentsProperty) {
        return { objects: [], opaque: false };
    }

    if (!Node.isPropertyAssignment(argumentsProperty)) {
        return { objects: [], opaque: true };
    }

    const initializer = argumentsProperty.getInitializer();
    const resolved = initializer === undefined ? undefined : resolveObjectLiteral(initializer);

    if (resolved === undefined) {
        return { objects: [], opaque: true };
    }

    return { objects: [resolved], opaque: hasUnreadableSpread(resolved) };
};

/**
 * Every `.input({...})` object literal walked leftward out of a builder chain.
 * A `.input(x)` whose argument is not an object literal marks the result opaque.
 */
const argumentsInChain = (receiver: TsNode): ProcedureArgumentObjects => {
    const objects: ObjectLiteralExpression[] = [];
    let opaque = false;
    let node: TsNode = receiver;

    while (Node.isCallExpression(node)) {
        const chainCallee = node.getExpression();

        if (!Node.isPropertyAccessExpression(chainCallee)) {
            break;
        }

        if (chainCallee.getName() === "input") {
            const argument = node.getArguments()[0];
            const resolved = argument !== undefined && Node.isExpression(argument) ? resolveObjectLiteral(argument) : undefined;

            if (resolved === undefined) {
                opaque = true;
            } else {
                objects.push(resolved);
                opaque ||= hasUnreadableSpread(resolved);
            }
        }

        node = chainCallee.getExpression();
    }

    return { objects, opaque };
};

/**
 * Read a procedure's argument declarations from whichever registration form it
 * uses: the builder chain when `receiver` is present, else the bare factory call.
 */
const procedureArgumentObjects = (call: CallExpression, receiver: TsNode | undefined): ProcedureArgumentObjects =>
    receiver ? argumentsInChain(receiver) : argumentsOfFactory(call);

/**
 * The declared argument names across `objects`. Covers both `email: v.string()`
 * (a property assignment) and the `{ email }` shorthand — missing the latter is
 * how a "does this procedure take an X?" check silently answers no.
 */
const argumentNames = (objects: ReadonlyArray<ObjectLiteralExpression>): string[] =>
    objects.flatMap((object) =>
        object
            .getProperties()
            .filter((property) => Node.isPropertyAssignment(property) || Node.isShorthandPropertyAssignment(property))
            .map((property) => (property as { getName: () => string }).getName()),
    );

export type { ProcedureArgumentObjects };
export { argumentNames, procedureArgumentObjects };
