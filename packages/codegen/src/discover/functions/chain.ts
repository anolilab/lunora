/**
 * The small predicates feeders reach for when inspecting a discovered
 * procedure: what its builder chain carries, and what its handler is.
 *
 * Grouped rather than one-per-export because they are one vocabulary — a feeder
 * that wants `procedureHandler` almost always wants `isDatabaseAccessor` in the
 * same breath, and five 10-line modules made the call sites harder to read than
 * the code they imported.
 */
import type { ArrowFunction, CallExpression, FunctionExpression, Node as TsNode } from "ts-morph";
import { Node } from "ts-morph";

import { builderChainSteps, wrappedCallsInChain } from "../builder-chain";

/** A function whose body we can inspect — an inline arrow or function expression handler. */
type InspectableHandler = ArrowFunction | FunctionExpression;

/** The inline arrow/function-expression handler at `argument`, or `undefined` when it isn't one. */
const inlineHandler = (argument: TsNode | undefined): InspectableHandler | undefined =>
    argument !== undefined && (Node.isArrowFunction(argument) || Node.isFunctionExpression(argument)) ? argument : undefined;

/** True when `receiver` is the database accessor: `ctx.db` (property named `db`) or a bare `db`. */
const isDatabaseAccessor = (receiver: TsNode): boolean =>
    (Node.isPropertyAccessExpression(receiver) && receiver.getName() === "db") || (Node.isIdentifier(receiver) && receiver.getText() === "db");

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

/** True when the builder chain rooted at `receiver` carries a step whose method name is `method` (`.output(...)` / `.use(...)`). */
const chainHasStep = (receiver: TsNode, method: string): boolean => builderChainSteps(receiver).some((step) => step.name === method);

/**
 * True when the builder chain rooted at `receiver` carries a
 * `.<method>(<wrappedCallee>(...))` step — e.g. `.use(mask(...))` or `.use(rls(...))`.
 *
 * Shares `wrappedCallsInChain` with `rlsCallsInChain` / `maskCallsInChain` so all
 * three answer the same question the same way. They had drifted: those two
 * resolved an import alias and this one compared callee text, so under
 * `import { rls as rowLevel }` a procedure read `usesRls: true` to
 * `discoverRlsProcedures` and `usesRls: false` to the feeders built on this.
 */
const chainUsesWrappedCall = (receiver: TsNode, method: string, wrappedCallee: string): boolean =>
    wrappedCallsInChain(receiver, method, wrappedCallee).length > 0;

export { chainHasStep, chainUsesWrappedCall, inlineHandler, isDatabaseAccessor, procedureHandler };
export type { InspectableHandler };
