/**
 * A compact, transport-safe description of one function argument — the runtime
 * read of a `v.*` validator's reflection tags (`kind` + `_meta`). The runtime
 * deliberately avoids a hard dependency on `@lunora/values`, so this reads the
 * validator structurally rather than importing its types.
 */
interface FunctionArgumentDescriptor {
    /** Element validator kind for an `array` arg (one level), e.g. `string`. */
    element?: string;
    /** The (optional-unwrapped) validator kind, e.g. `string`, `id`, `object`. */
    kind: string;
    /** The argument name. */
    name: string;
    /** True when the arg is wrapped in `v.optional(...)`. */
    optional: boolean;
    /** Target table for an `id` arg (`v.id("table")`). */
    table?: string;
}

/** The structural shape of a validator the serializer reads (kind tag + reflection meta). */
interface ValidatorLike {
    _meta?: Record<string, unknown>;
    kind?: string;
}

const asValidator = (value: unknown): ValidatorLike => (typeof value === "object" && value !== null ? value : {});

const kindOf = (validator: ValidatorLike): string => (typeof validator.kind === "string" ? validator.kind : "unknown");

/**
 * Describe one named argument from its validator. Unwraps a single `v.optional`
 * layer (marking the arg optional and reporting the inner kind), and surfaces
 * the two most useful per-kind details: an `id` arg's target table and an
 * `array` arg's element kind. Nested object/union shapes report their top-level
 * kind only — enough for a signature view without a deep recursive walk.
 */
const describeArgument = (name: string, validator: unknown): FunctionArgumentDescriptor => {
    let current = asValidator(validator);
    let optional = false;

    if (kindOf(current) === "optional") {
        optional = true;
        current = asValidator(current._meta?.["inner"]);
    }

    const kind = kindOf(current);
    const meta = current._meta ?? {};
    const descriptor: FunctionArgumentDescriptor = { kind, name, optional };

    if (kind === "id" && typeof meta["tableName"] === "string") {
        descriptor.table = meta["tableName"];
    }

    if (kind === "array") {
        const elementKind = kindOf(asValidator(meta["inner"]));

        if (elementKind !== "unknown") {
            descriptor.element = elementKind;
        }
    }

    return descriptor;
};

/**
 * Describe a function's whole argument map (`{ name: validator }`), sorted by
 * name for a stable response. Returns `[]` for a function with no declared args
 * or an args value that isn't an object.
 */
const describeArguments = (args: unknown): FunctionArgumentDescriptor[] => {
    if (typeof args !== "object" || args === null) {
        return [];
    }

    return Object.entries(args as Record<string, unknown>)
        .map(([name, validator]) => describeArgument(name, validator))
        .toSorted((a, b) => a.name.localeCompare(b.name));
};

export { describeArgument, describeArguments };
export type { FunctionArgumentDescriptor };
