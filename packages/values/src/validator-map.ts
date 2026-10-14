import { ValidationError } from "./errors";
import type { Infer, OptionalizeShape, Validator } from "./v";

/** Map of validators describing a record of named fields (a function's args, a step's args, an HTTP query/body/params). */
type ValidatorMap = Record<string, Validator>;

/**
 * Infer the object type from a {@link ValidatorMap} — optional validators
 * (`v.optional`) become optional keys. Shares the single optionality rule with
 * `ObjectShapeType` via {@link OptionalizeShape}, so args-map and object-shape
 * inference can never drift.
 */
type InferValidatorMap<A extends ValidatorMap> = OptionalizeShape<{ [K in keyof A]: Infer<A[K]> }>;

/**
 * A precompiled fast-path parser for one {@link ValidatorMap}. Returns the fully
 * built, validated record on a confident success, or the {@link DEFER_VALIDATION}
 * sentinel to hand the input back to the interpreted parser.
 *
 * The contract is soundness, not completeness: a compiled parser may return
 * {@link DEFER_VALIDATION} for any input it is not certain about (the interpreted
 * path then runs and either succeeds or throws the canonical error), but it must
 * NEVER return a built record for input the interpreted parser would reject, and
 * the record it returns must be byte-for-byte what the interpreted parser would
 * have produced. This lets `@lunora/codegen` emit zero-allocation structural
 * checks (the common case) while every error message and every tricky validator
 * still flows through the single interpreted implementation below — so error
 * contracts can never drift.
 *
 * The `source` parameter is intentionally `any`: the codegen-emitted body is
 * plain JavaScript (no type annotations — it must also be loadable via
 * `new Function` in the compiler's differential tests) that index-walks the input
 * to arbitrary depth, which strict TypeScript forbids on `unknown`/`object`. An
 * `any` input lets the emitted structural checks type-check cleanly while the
 * RESULT stays strongly typed; soundness is enforced by the differential test
 * harness, not the input type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see doc above: the emitted plain-JS body deep-indexes the input; `any` keeps generated code annotation-free and strict-clean
type CompiledValidatorMap = (source: any) => Record<string, unknown> | typeof DEFER_VALIDATION;

/**
 * Sentinel a {@link CompiledValidatorMap} returns to defer to the interpreted
 * parser. A unique symbol (never a valid parse result — {@link parseValidatorMap}
 * always yields a record) so the seam can distinguish "compiled handled it" from
 * "compiled bailed" with a single identity check and no per-call allocation.
 */
const DEFER_VALIDATION: unique symbol = Symbol("lunora.deferValidation");

/**
 * Per-map registry of compiled fast-path parsers, keyed on the validators-map
 * object identity (a WeakMap so an unreferenced map is collected, and so we never
 * mutate the caller's object). `@lunora/codegen` emits one compiled parser per
 * eligible function and installs it via {@link installCompiledValidatorMap} at
 * generated-module load; because the registered function's `args` object is the
 * same reference the procedure builder validates against, the install
 * transparently accelerates that function's dispatch with no change to the
 * builder or the call sites.
 */
const COMPILED_PARSERS = new WeakMap<ValidatorMap, CompiledValidatorMap>();

/**
 * Install a compiled fast-path parser for `validators`. Idempotent-ish: a second
 * install overwrites the first (codegen emits each map once, so this only matters
 * if a host installs by hand). See {@link CompiledValidatorMap} for the contract
 * the parser must honour.
 */
const installCompiledValidatorMap = (validators: object, compiled: CompiledValidatorMap): void => {
    // `validators` is typed `object` (not `ValidatorMap`) so codegen can pass a
    // registered function's loosely-typed `.args` straight through without a cast;
    // only the object identity matters as the WeakMap key.
    COMPILED_PARSERS.set(validators as ValidatorMap, compiled);
};

/**
 * Validate each declared field of `source` through its validator, re-wrapping
 * any {@link ValidationError} with a `label.<key>:` prefix and the rebuilt path
 * `[key, ...error.path]` so the failure points at the offending field. Optional
 * fields absent from the source are skipped (so `v.optional` passes and a
 * required validator fails on `undefined`).
 *
 * The single arg-/field-parsing implementation shared across the framework — the
 * procedure builder (label `args`), the HTTP route builder (`searchParams` /
 * `body` / `params`), and `@lunora/workflow`'s reusable steps (`step args`) — so
 * the error-prefixing and optional-skip semantics can't drift apart. The `label`
 * is the only thing each caller varies.
 *
 * When a codegen-emitted {@link CompiledValidatorMap} is installed for this exact
 * `validators` object, the fast path runs first; it either returns the finished
 * record (a confident success — the common case) or {@link DEFER_VALIDATION}, in
 * which case the interpreted loop below runs and owns the result (and any error).
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- validator-map parser; the branch set is inherent to the validator kinds
const parseValidatorMap = (validators: ValidatorMap, source: Record<string, unknown>, label: string): Record<string, unknown> => {
    const compiled = COMPILED_PARSERS.get(validators);

    if (compiled !== undefined) {
        const fast = compiled(source);

        if (fast !== DEFER_VALIDATION) {
            return fast;
        }
    }

    const out: Record<string, unknown> = {};

    for (const key of Object.keys(validators)) {
        const validator = validators[key];

        if (!validator) {
            continue;
        }

        // Read via Object.hasOwn so a declared arg whose name collides with an
        // Object.prototype member (`toString`, `constructor`, …) reads as absent
        // (`undefined`) rather than the inherited function — otherwise the
        // optional-skip below never fires and a real HTTP body missing such a
        // field would reject on the inherited function. Note: an absent optional
        // arg is skipped wholesale, so a `.check()` refinement on a
        // `v.optional(...)` arg never runs for an absent arg (it does standalone).
        const candidate = Object.hasOwn(source, key) ? source[key] : undefined;

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

export type { CompiledValidatorMap, InferValidatorMap, ValidatorMap };
export { DEFER_VALIDATION, installCompiledValidatorMap, parseValidatorMap };
