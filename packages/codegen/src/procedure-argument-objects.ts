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
const hasUnreadableSpread = (object: ObjectLiteralExpression, active: Set<ObjectLiteralExpression> = new Set()): boolean => {
    // A cycle is UNREADABLE, not readable. `parseObjectShape` breaks the same
    // cycle by emitting nothing for it, so answering `false` here would claim a
    // shape is fully known while its fields were dropped — the exact wrong
    // direction for a flag security lints gate on.
    //
    // `active` is the current recursion PATH, not every object seen: a diamond
    // (`{ ...a, ...b }` where both spread `base`) visits `base` twice and is
    // perfectly readable, so a visited-set would call it a cycle.
    if (active.has(object)) {
        return true;
    }

    active.add(object);

    try {
        return object.getProperties().some((property) => {
            if (!Node.isSpreadAssignment(property)) {
                return false;
            }

            const resolved = resolveObjectLiteral(property.getExpression());

            return resolved === undefined || hasUnreadableSpread(resolved, active);
        });
    } finally {
        active.delete(object);
    }
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
 * The declared argument names of one object literal, following a spread into the
 * record it names.
 *
 * The spread hop is what keeps the security lints honest. A resolvable spread is
 * reported as NOT opaque — the fields are knowable — so a names list that could
 * not see through it would let `declaresEmailArgument` answer a confident "no"
 * for `.input({ ...signupArgs })` whose record declares `email`, and the
 * disposable-address gating would be skipped on exactly the mutation that needs
 * it. An UNRESOLVABLE spread keeps the shape opaque, so the "unknown" answer
 * still covers what this cannot enumerate.
 */
const namesOfObject = (object: ObjectLiteralExpression, active: Set<ObjectLiteralExpression>): string[] => {
    if (active.has(object)) {
        return [];
    }

    active.add(object);

    try {
        return object.getProperties().flatMap((property) => {
            if (Node.isSpreadAssignment(property)) {
                const resolved = resolveObjectLiteral(property.getExpression());

                return resolved === undefined ? [] : namesOfObject(resolved, active);
            }

            return Node.isPropertyAssignment(property) || Node.isShorthandPropertyAssignment(property) ? [property.getName()] : [];
        });
    } finally {
        active.delete(object);
    }
};

/**
 * The declared argument names across `objects`. Covers `email: v.string()` (a
 * property assignment), the `{ email }` shorthand — missing the latter is how a
 * "does this procedure take an X?" check silently answers no — and the fields a
 * readable `{ ...spread }` contributes.
 */
const argumentNames = (objects: ReadonlyArray<ObjectLiteralExpression>): string[] => objects.flatMap((object) => namesOfObject(object, new Set()));

export type { ProcedureArgumentObjects };
export { argumentNames, procedureArgumentObjects };
