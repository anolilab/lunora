import { parseValidatorMap } from "@lunora/values";

import type { ArgsValidator, InferArgs } from "./types";

/**
 * Validate an args record against the validator map. Throws a
 * `ValidationError` with the offending field's path on mismatch.
 *
 * Exported so the procedure builder (`./builder`) reuses one validator
 * implementation rather than forking the arg-parsing logic. The shared
 * field-parser lives in `@lunora/values` ({@link parseValidatorMap}) so the
 * procedure builder, the HTTP route builder, and `@lunora/workflow` steps share
 * one optional-skip + error-prefix implementation; here we pin the `args` label.
 */
const validateArgs = <A extends ArgsValidator>(validators: A, args: Record<string, unknown>): InferArgs<A> =>
    parseValidatorMap(validators, args, "args") as InferArgs<A>;

export { parseValidatorMap } from "@lunora/values";
export { validateArgs };
