/**
 * Compile-time only: exercised by `tsc --noEmit` via the package tsconfig's
 * `__tests__/**` include. Pins the ONE optionality rule — "the parser accepts
 * this field absent" — across the two inference paths that share
 * `OptionalizeShape` (nested `v.object(...)` and a top-level args map), and
 * against the property shape `@lunora/codegen` emits into `_generated/api.ts`.
 *
 * The runtime half of the same contract lives in `v.test.ts` /
 * `validator-map.test.ts`; the emitter half in `@lunora/codegen`'s
 * `emit-api.test.ts`. All three have to agree or a handler's own `args` stops
 * being passable to a procedure declaring the identical validator (issue #688).
 */
import type { Infer, InferValidatorMap } from "../src/index";
import { v } from "../src/index";
import type { Assert, Equal, Extends, OptionalKeys, RequiredKeys } from "./__helpers__/type-assert";

// --- `v.any()` is an OPTIONAL key, in both positions -------------------------

// `v.any()` returns its input unchanged, so an absent field parses — the key is
// optional. `v.optional(v.any())` is the same answer by a second route.
const anyShape = v.object({ data: v.any(), id: v.string(), maybe: v.optional(v.any()) });

type AnyShape = Infer<typeof anyShape>;

type _AnyObjectOptionalKeys = Assert<Equal<OptionalKeys<AnyShape>, "data" | "maybe">>;
type _AnyObjectRequiredKeys = Assert<Equal<RequiredKeys<AnyShape>, "id">>;
// The VALUE type is untouched — `v.any()` infers `unknown`, which already
// subsumes the `undefined` the optional key admits.
type _AnyObjectValueType = Assert<Equal<AnyShape["data"], unknown>>;

// The same rule at the top level of an args map — the `.input({...})` position.
const anyArgs = { data: v.any(), id: v.string() };

type AnyArgs = InferValidatorMap<typeof anyArgs>;

type _AnyArgsOptionalKeys = Assert<Equal<OptionalKeys<AnyArgs>, "data">>;
type _AnyArgsRequiredKeys = Assert<Equal<RequiredKeys<AnyArgs>, "id">>;

// --- the rules that must NOT change ------------------------------------------

// `v.optional(T)` is optional; a bare validator is required.
const optionalArgs = { nick: v.optional(v.string()), title: v.string() };

type _OptionalArgsOptionalKeys = Assert<Equal<OptionalKeys<InferValidatorMap<typeof optionalArgs>>, "nick">>;
type _OptionalArgsRequiredKeys = Assert<Equal<RequiredKeys<InferValidatorMap<typeof optionalArgs>>, "title">>;

// A `v.union(...)` containing `v.null()` admits `null`, never `undefined` — the
// key stays REQUIRED. A union containing `v.any()` (or an optional member) does
// admit `undefined`, and the runtime parses it absent, so that one is optional.
const unionArgs = {
    absentTolerant: v.union(v.string(), v.any()),
    nullable: v.union(v.string(), v.null()),
    optionalMember: v.union(v.string(), v.optional(v.number())),
};

type UnionArgs = InferValidatorMap<typeof unionArgs>;

type _UnionOptionalKeys = Assert<Equal<OptionalKeys<UnionArgs>, "absentTolerant" | "optionalMember">>;
type _UnionRequiredKeys = Assert<Equal<RequiredKeys<UnionArgs>, "nullable">>;
type _UnionNullableType = Assert<Equal<UnionArgs["nullable"], string | null>>;

// `v.record(...)` and `v.array(...)` are plain required keys.
const containerArgs = { rows: v.array(v.string()), tags: v.record(v.string(), v.number()) };

type ContainerArgs = InferValidatorMap<typeof containerArgs>;

type _ContainerRequiredKeys = Assert<Equal<RequiredKeys<ContainerArgs>, "rows" | "tags">>;
type _ContainerRecordType = Assert<Equal<ContainerArgs["tags"], Record<string, number>>>;

// --- issue #688: the inferred args type and the emitted reference agree ------

/**
 * The repro shape: a `v.optional(...)` wrapping an object that holds a bare
 * `v.any()`. `v.optional()` around the object is what forced the two sides into
 * direct comparison — `ctx.runMutation(internal.x.sink, { shape: args.shape })`.
 */
const probeArgs = { shape: v.optional(v.object({ data: v.any(), id: v.string() })) };

/**
 * What `@lunora/codegen` emits for `probeArgs` into `_generated/api.ts`:
 * `FunctionReference<"mutation", { shape?: { data?: unknown; id: string } }, null>`.
 * Written out by hand so this file fails if the emitter's rule drifts from the
 * inference rule again — the emitter used to render a REQUIRED `data: unknown`.
 */
interface EmittedProbeArgs {
    shape?: { data?: unknown; id: string };
}

type ProbeArgs = InferValidatorMap<typeof probeArgs>;

// Both directions: a handler's own `args` must be passable to the generated
// reference, and a call-site literal must satisfy the handler's parameter.
type _ProbeArgsReachEmitted = Assert<Extends<ProbeArgs, EmittedProbeArgs>>;
type _EmittedReachProbeArgs = Assert<Extends<EmittedProbeArgs, ProbeArgs>>;

export type {
    _AnyArgsOptionalKeys,
    _AnyArgsRequiredKeys,
    _AnyObjectOptionalKeys,
    _AnyObjectRequiredKeys,
    _AnyObjectValueType,
    _ContainerRecordType,
    _ContainerRequiredKeys,
    _EmittedReachProbeArgs,
    _OptionalArgsOptionalKeys,
    _OptionalArgsRequiredKeys,
    _ProbeArgsReachEmitted,
    _UnionNullableType,
    _UnionOptionalKeys,
    _UnionRequiredKeys,
};
