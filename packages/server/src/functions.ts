import { ValidationError } from "@lunora/values";

import type {
    ActionCtx as ActionContext,
    ArgsValidator,
    FunctionVisibility,
    InferArgs,
    MutationCtx as MutationContext,
    QueryCtx as QueryContext,
    RegisteredAction,
    RegisteredMutation,
    RegisteredQuery,
} from "./types";

/**
 * Validate each declared field of `source` through its validator, re-wrapping
 * any {@link ValidationError} with a `label.&lt;key>:` prefix and the rebuilt path
 * `[key, ...error.path]` so the failure points at the offending field. Optional
 * fields absent from the source are skipped (so `v.optional` passes and a
 * required validator fails on `undefined`).
 *
 * The single arg-/field-parsing implementation shared by the procedure builder
 * ({@link validateArgs}, label `args`) and the HTTP route builder (search
 * params / body / path params, each with its own label) so the error-prefixing
 * and optional-skip semantics can't drift apart.
 */
const parseValidatorMap = (validators: ArgsValidator, source: Record<string, unknown>, label: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};

    for (const key of Object.keys(validators)) {
        const validator = validators[key];

        if (!validator) {
            continue;
        }

        const candidate = source[key];

        if (candidate === undefined && validator.kind === "optional") {
            continue;
        }

        try {
            out[key] = validator.parse(candidate);
        } catch (error: unknown) {
            if (error instanceof ValidationError) {
                throw new ValidationError(`${label}.${key}: ${error.message}`, {
                    expected: error.expected,
                    path: [key, ...error.path],
                    received: error.received,
                });
            }

            throw error;
        }
    }

    return out;
};

/**
 * Validate an args record against the validator map. Throws a
 * {@link ValidationError} with the offending field's path on mismatch.
 *
 * Exported so the procedure builder (`./builder`) reuses one validator
 * implementation rather than forking the arg-parsing logic.
 */
const validateArgs = <A extends ArgsValidator>(validators: A, args: Record<string, unknown>): InferArgs<A> =>
    parseValidatorMap(validators, args, "args") as InferArgs<A>;

interface QueryDefinition<A extends ArgsValidator, R> {
    args: A;
    handler: (context: QueryContext, args: InferArgs<A>) => Promise<R> | R;
}

interface MutationDefinition<A extends ArgsValidator, R> {
    args: A;
    handler: (context: MutationContext, args: InferArgs<A>) => Promise<R> | R;
}

interface ActionDefinition<A extends ArgsValidator, R> {
    args: A;
    handler: (context: ActionContext, args: InferArgs<A>) => Promise<R> | R;
}

const wrap = <A extends ArgsValidator, R, Kind extends "action" | "mutation" | "query">(
    kind: Kind,
    definition: { args: A; handler: (context: never, args: InferArgs<A>) => Promise<R> | R },
    visibility?: FunctionVisibility,
): { args: A; handler: (context: unknown, args: InferArgs<A>) => Promise<R> | R; kind: Kind; visibility?: FunctionVisibility } => {
    return {
        args: definition.args,
        handler: (context: unknown, args: InferArgs<A>) => {
            const parsed = validateArgs(definition.args, args as Record<string, unknown>);

            return definition.handler(context as never, parsed);
        },
        kind,
        // Only attach the key when internal so public registrations keep emitting
        // the bare `{ args, handler, kind }` shape (absence === public).
        ...(visibility ? { visibility } : {}),
    };
};

/** Register a query function reachable from clients via the generated `api`. */
const query = <A extends ArgsValidator, R>(definition: QueryDefinition<A, R>): RegisteredQuery<A, R> => wrap("query", definition);

/** Register a mutation function reachable from clients via the generated `api`. */
const mutation = <A extends ArgsValidator, R>(definition: MutationDefinition<A, R>): RegisteredMutation<A, R> => wrap("mutation", definition);

/** Register an action function (HTTP/external side effects allowed) reachable from clients via the generated `api`. */
const action = <A extends ArgsValidator, R>(definition: ActionDefinition<A, R>): RegisteredAction<A, R> => wrap("action", definition);

/** Register an internal query — callable only server-side via `ctx.runQuery`, never from a client. */
const internalQuery = <A extends ArgsValidator, R>(definition: QueryDefinition<A, R>): RegisteredQuery<A, R> => wrap("query", definition, "internal");

/** Register an internal mutation — callable only server-side via `ctx.runMutation`, never from a client. */
const internalMutation = <A extends ArgsValidator, R>(definition: MutationDefinition<A, R>): RegisteredMutation<A, R> =>
    wrap("mutation", definition, "internal");

/** Register an internal action — callable only server-side via `ctx.runAction`, never from a client. */
const internalAction = <A extends ArgsValidator, R>(definition: ActionDefinition<A, R>): RegisteredAction<A, R> => wrap("action", definition, "internal");

export { action, internalAction, internalMutation, internalQuery, mutation, parseValidatorMap, query, validateArgs };

export type { ActionDefinition, MutationDefinition, QueryDefinition };
