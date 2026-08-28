import type { CallExpression, ObjectLiteralExpression } from "ts-morph";
import { Node } from "ts-morph";

import type { ExposeCacheIR, ValidatorIR } from "../../../ir";
import { parseObjectShape } from "../../../parse-validator";
import { builderChainSteps } from "../../builder-chain";

/** Read a property off an object literal as a string literal, or `undefined` when absent / not statically readable. */
const stringProperty = (literal: ObjectLiteralExpression, name: string): string | undefined => {
    const property = literal.getProperty(name);

    if (property === undefined || !Node.isPropertyAssignment(property)) {
        return undefined;
    }

    const initializer = property.getInitializer();

    return initializer !== undefined && Node.isStringLiteral(initializer) ? initializer.getLiteralValue() : undefined;
};

/** Read a property off an object literal as a numeric literal, or `undefined` when absent / not statically readable. */
const numberProperty = (literal: ObjectLiteralExpression, name: string): number | undefined => {
    const property = literal.getProperty(name);

    if (property === undefined || !Node.isPropertyAssignment(property)) {
        return undefined;
    }

    const initializer = property.getInitializer();

    return initializer !== undefined && Node.isNumericLiteral(initializer) ? initializer.getLiteralValue() : undefined;
};

/**
 * Read the `cache: { … }` sub-object of an `.expose(...)` argument into
 * {@link ExposeCacheIR}. Only literal fields are recorded — a computed `maxAge`
 * is simply omitted, so the emitted spec under-documents rather than states
 * something the runtime won't do. Returns `undefined` when there is no readable
 * `cache` object at all.
 */
const cacheFromExposeLiteral = (literal: ObjectLiteralExpression): ExposeCacheIR | undefined => {
    const property = literal.getProperty("cache");

    if (property === undefined || !Node.isPropertyAssignment(property)) {
        return undefined;
    }

    const initializer = property.getInitializer();

    if (initializer === undefined || !Node.isObjectLiteralExpression(initializer)) {
        return undefined;
    }

    const scope = stringProperty(initializer, "scope");
    const maxAge = numberProperty(initializer, "maxAge");
    const staleWhileRevalidate = numberProperty(initializer, "staleWhileRevalidate");
    const tag = stringProperty(initializer, "tag");
    const vary = stringProperty(initializer, "vary");

    const read: ExposeCacheIR = {
        ...(maxAge === undefined ? {} : { maxAge }),
        ...(scope === "private" || scope === "public" ? { scope } : {}),
        ...(staleWhileRevalidate === undefined ? {} : { staleWhileRevalidate }),
        ...(tag === undefined ? {} : { tag }),
        ...(vary === undefined ? {} : { vary }),
    };

    // Nothing readable (every field computed) is reported as absent rather than as
    // an empty object, so a consumer can't mistake "unreadable" for "declared".
    return Object.keys(read).length === 0 ? undefined : read;
};

/**
 * Read the argument of a located `.expose(...)` call into the IR tag. An
 * unreadable argument (not an object literal, or a computed `rest`) yields `{}` —
 * "exposed, details unknown" — which is the safe default: the function is still
 * treated as tagged, just without a `rest === true` that would publish it.
 */
const exposeFromArgument = (argument: Node | undefined): { cache?: ExposeCacheIR; rest?: boolean } => {
    if (argument === undefined || !Node.isObjectLiteralExpression(argument)) {
        return {};
    }

    const cache = cacheFromExposeLiteral(argument);
    const restProperty = argument.getProperty("rest");

    if (restProperty !== undefined && Node.isPropertyAssignment(restProperty)) {
        return { ...(cache === undefined ? {} : { cache }), rest: restProperty.getInitializer()?.getText() === "true" };
    }

    return cache === undefined ? {} : { cache };
};

/**
 * Walk a builder-terminal chain (`c.input(...).expose({ rest: true }).query(...)`)
 * leftward looking for a `.expose({ ... })` modifier, and read its `rest` flag and
 * optional `cache` block from the object-literal argument. Returns the tag when
 * found, else `undefined` (RPC-only — the default). Mirrors
 * `resolveBuilderRootKind`'s chain descent so it works under degraded types
 * (no `@lunora/server` install).
 */
const exposeFromBuilderChain = (receiver: Node): { cache?: ExposeCacheIR; rest?: boolean } | undefined => {
    const step = builderChainSteps(receiver).find((candidate) => candidate.name === "expose");

    return step ? exposeFromArgument(step.call.getArguments()[0]) : undefined;
};

/** Inspect a `query({ args, handler })` call and pull out the args validator map. */
const argsFromCall = (call: CallExpression): Record<string, ValidatorIR> => {
    const first = call.getArguments()[0];

    if (!first || !Node.isObjectLiteralExpression(first)) {
        return {};
    }

    const argsProperty = first.getProperty("args");

    if (!argsProperty || !Node.isPropertyAssignment(argsProperty)) {
        return {};
    }

    const initializer = argsProperty.getInitializer();

    if (!initializer || !Node.isObjectLiteralExpression(initializer)) {
        return {};
    }

    return parseObjectShape(initializer);
};

export { argsFromCall, exposeFromBuilderChain };
