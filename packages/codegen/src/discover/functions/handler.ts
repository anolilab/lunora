/**
 * Getting from a registration call to a handler body a feeder can walk.
 *
 * The chain predicates that used to live here moved to `discover/builder-chain.ts`
 * beside the walk they are one-liners over, and `isDatabaseAccessor` to
 * `discover/ast.ts` where three inline copies of it already were. What is left is
 * one concept, which is what the file is now named for.
 */
import type { ArrowFunction, CallExpression, FunctionExpression, Node as TsNode } from "ts-morph";
import { Node } from "ts-morph";

/** A function whose body we can inspect — an inline arrow or function expression handler. */
type InspectableHandler = ArrowFunction | FunctionExpression;

/** The inline arrow/function-expression handler at `argument`, or `undefined` when it isn't one. */
const inlineHandler = (argument: TsNode | undefined): InspectableHandler | undefined =>
    argument !== undefined && (Node.isArrowFunction(argument) || Node.isFunctionExpression(argument)) ? argument : undefined;

/**
 * The inline handler function of a classified procedure call, or `undefined` when
 * it isn't inspectable. The terminal call's first argument is either the handler
 * function directly (`query(async ({ ctx }) => …)` / `c.use(…).query(handler)`) or
 * an object literal carrying it under a `handler` property (`query({ args, handler })`)
 * — both surface forms are handled. The companion to `classifyProcedureCall`:
 * classify the call, then pull out the body to inspect.
 */
const procedureHandler = (initializer: CallExpression): InspectableHandler | undefined => {
    const argument = initializer.getArguments()[0];
    const direct = inlineHandler(argument);

    if (direct !== undefined) {
        return direct;
    }

    if (argument === undefined || !Node.isObjectLiteralExpression(argument)) {
        return undefined;
    }

    const property = argument.getProperty("handler");

    return property !== undefined && Node.isPropertyAssignment(property) ? inlineHandler(property.getInitializer()) : undefined;
};

export { inlineHandler, procedureHandler };
export type { InspectableHandler };
