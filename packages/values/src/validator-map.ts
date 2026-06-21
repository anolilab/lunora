import { ValidationError } from "./errors";
import type { Infer, Validator } from "./v";

/** Map of validators describing a record of named fields (a function's args, a step's args, an HTTP query/body/params). */
type ValidatorMap = Record<string, Validator>;

/** Infer the object type from a {@link ValidatorMap} — optional validators (`v.optional`) become optional keys. */
type InferValidatorMap<A extends ValidatorMap> = {
    [K in keyof A as undefined extends Infer<A[K]> ? K : never]?: Infer<A[K]>;
} & { [K in keyof A as undefined extends Infer<A[K]> ? never : K]: Infer<A[K]> };

/**
 * Validate each declared field of `source` through its validator, re-wrapping
 * any {@link ValidationError} with a `label.&lt;key>:` prefix and the rebuilt path
 * `[key, ...error.path]` so the failure points at the offending field. Optional
 * fields absent from the source are skipped (so `v.optional` passes and a
 * required validator fails on `undefined`).
 *
 * The single arg-/field-parsing implementation shared across the framework — the
 * procedure builder (label `args`), the HTTP route builder (`searchParams` /
 * `body` / `params`), and `@lunora/workflow`'s reusable steps (`step args`) — so
 * the error-prefixing and optional-skip semantics can't drift apart. The `label`
 * is the only thing each caller varies.
 */
const parseValidatorMap = (validators: ValidatorMap, source: Record<string, unknown>, label: string): Record<string, unknown> => {
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

export type { InferValidatorMap, ValidatorMap };
export { parseValidatorMap };
