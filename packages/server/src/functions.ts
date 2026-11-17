import { parseValidatorMap, sensitiveArgumentNames } from "@lunora/values";

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

/**
 * The ctx key a shard hands its dispatch's sensitive scope under. A validator may
 * transform a marked value (trim, decode, parse), and the scope the shard opens
 * from the raw args never sees the result, so the parsed value is handed back
 * through this key. A symbol keeps it off the handler's typed ctx. The codegen
 * emitter writes the same `Symbol.for` key literally into the generated ctx.
 */
const ADMIT_SENSITIVE_ARGS = Symbol.for("lunora.admitSensitiveArgs");

/**
 * Admit the parsed values of a function's marked arguments into the dispatch that
 * runs it. Called right after {@link validateArgs}, before middleware or the handler
 * can log anything. A no-op when no argument is marked or the ctx is not a shard's.
 */
const admitSensitiveArgs = (context: unknown, validators: Readonly<Record<string, unknown>>, parsed: Record<string, unknown>): void => {
    const names = sensitiveArgumentNames(validators);

    if (names.size === 0 || typeof context !== "object" || context === null) {
        return;
    }

    const admit = (context as Record<symbol, unknown>)[ADMIT_SENSITIVE_ARGS];

    if (typeof admit === "function") {
        (admit as (args: Record<string, unknown>, names: ReadonlySet<string>) => void)(parsed, names);
    }
};

export { parseValidatorMap } from "@lunora/values";
export { admitSensitiveArgs, validateArgs };
