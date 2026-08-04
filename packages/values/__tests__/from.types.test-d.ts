/**
 * Compile-time only: exercised by `tsc --noEmit` via the package tsconfig's
 * `__tests__/**` include. Asserts that `v.from()` recovers the wrapped schema's
 * inferred type when `~standard.types` is declared the way the spec declares it
 * — OPTIONAL. Every real library (zod, valibot, arktype) does, because the
 * property is a phantom that never exists at runtime, and a matcher that forgets
 * the optionality degrades all of them to `unknown`.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { InferSelect, v } from "../src/index";

type Assert<T extends true> = T;
// The canonical type-equality idiom: the single-use `<T>()` params are
// load-bearing (they force structural comparison), so the rule is disabled here.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

interface Page {
    cursor: string | null;
    limit: number;
}

// Shaped exactly like a zod/valibot schema: `types` is declared and optional.
declare const specSchema: StandardSchemaV1<Page, Page>;

type _FromSpec = Assert<Equal<InferSelect<ReturnType<typeof v.from<typeof specSchema>>>, Page>>;

// A schema that declares no `types` at all is still legal, and still has to land
// on `unknown` rather than `never`.
declare const untypedSchema: {
    readonly "~standard": {
        readonly validate: (value: unknown) => { value: unknown };
        readonly vendor: string;
        readonly version: 1;
    };
};

type _FromUntyped = Assert<Equal<InferSelect<ReturnType<typeof v.from<typeof untypedSchema>>>, unknown>>;

export type { _FromSpec, _FromUntyped };
