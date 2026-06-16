import { ValidationError } from "@lunora/values";

import type { ArgsValidator, InferArgs } from "./types";

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

export { parseValidatorMap, validateArgs };
