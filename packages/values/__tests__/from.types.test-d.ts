/**
 * Compile-time only: exercised by `tsc --noEmit` via the package tsconfig's
 * `__tests__/**` include. Pins what `v.from()` recovers from a Standard Schema.
 *
 * The fixtures are deliberately TRANSFORMING (`Input` ≠ `Output`). A schema whose
 * input and output coincide cannot fail these assertions in the interesting
 * direction: swap the implementation to read the input side and a same-type
 * fixture still passes, so it would pin the bug that was reported rather than the
 * contract that was wrong.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { InferInsert, InferSelect, v } from "../src/index";
import type { Assert, Equal } from "./__helpers__/type-assert";

/**
 * Shaped exactly like a zod/valibot/arktype schema: `~standard.types` is declared
 * and OPTIONAL. Matching that union against `{ output: infer O }` without
 * stripping the optionality misses every real library and yields `unknown`.
 */
declare const coercingSchema: StandardSchemaV1<string, number>;

// A read gets the schema's output back — it is `validate()`'s result that is stored.
type _SelectIsOutput = Assert<Equal<InferSelect<ReturnType<typeof v.from<typeof coercingSchema>>>, number>>;

// A write supplies the schema's input — the value the validator exists to transform.
type _InsertIsInput = Assert<Equal<InferInsert<ReturnType<typeof v.from<typeof coercingSchema>>>, string>>;

/**
 * A schema declaring no `~standard.types` at all is still spec-legal. It has to
 * land on `unknown` rather than `never`, which is what resolving the indexed
 * access through the constraint gives.
 */
declare const untypedSchema: {
    readonly "~standard": {
        readonly validate: (value: unknown) => { value: unknown };
        readonly vendor: string;
        readonly version: 1;
    };
};

type _UntypedSelect = Assert<Equal<InferSelect<ReturnType<typeof v.from<typeof untypedSchema>>>, unknown>>;
type _UntypedInsert = Assert<Equal<InferInsert<ReturnType<typeof v.from<typeof untypedSchema>>>, unknown>>;

export type { _InsertIsInput, _SelectIsOutput, _UntypedInsert, _UntypedSelect };
