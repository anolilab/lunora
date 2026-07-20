/**
 * Compile-time only: exercised by `tsc --noEmit` via the package tsconfig's
 * `__tests__/**` include. Asserts the insert/select type divergence produced by
 * the column-modifier API (`.default`, `.$defaultFn`, `.unique`, `.nullable`).
 */
import type { ColumnValidator, Id, InferInsert, InferSelect, InsertShape, SelectShape, TimestampColumnValidator } from "../src/index";
import { v } from "../src/index";

type Assert<T extends true> = T;
// The canonical type-equality idiom: the single-use `<T>()` params are
// load-bearing (they force structural comparison), so the rule is disabled here.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];

// --- scalar modifiers ---------------------------------------------------------

// `.default(value)` leaves select alone but makes insert accept `undefined`.
const priority: ColumnValidator<string, string | undefined> = v.string().default("medium");

type _DefaultSelect = Assert<Equal<InferSelect<typeof priority>, string>>;
type _DefaultInsert = Assert<Equal<InferInsert<typeof priority>, string | undefined>>;

// `.$defaultFn(fn)` behaves like `.default` for optionality.
const createdAt: ColumnValidator<number, number | undefined> = v.number().$defaultFn(() => Date.now());

type _DefaultFunctionSelect = Assert<Equal<InferSelect<typeof createdAt>, number>>;
type _DefaultFunctionInsert = Assert<Equal<InferInsert<typeof createdAt>, number | undefined>>;

// `.$onUpdateFn(fn)` does NOT make the field optional on insert.
const updatedAt: ColumnValidator<number, number> = v.number().$onUpdateFn(() => Date.now());

type _OnUpdateInsert = Assert<Equal<InferInsert<typeof updatedAt>, number>>;

// `.serverDefault(fn)` leaves select alone but makes insert optional — the
// server stamps it, so the client need not (and cannot meaningfully) supply it.
const ownerId: ColumnValidator<string, string | undefined> = v.string().serverDefault(({ auth }) => auth.userId ?? "anon");

type _ServerDefaultSelect = Assert<Equal<InferSelect<typeof ownerId>, string>>;
type _ServerDefaultInsert = Assert<Equal<InferInsert<typeof ownerId>, string | undefined>>;

// `.unique()` is type-transparent.
const title: ColumnValidator<string, string> = v.string().unique();

type _UniqueSelect = Assert<Equal<InferSelect<typeof title>, string>>;
type _UniqueInsert = Assert<Equal<InferInsert<typeof title>, string>>;

// `.nullable()` widens both select and insert to `T | null`.
const note: ColumnValidator<string | null, string | null> = v.string().nullable();

type _NullableSelect = Assert<Equal<InferSelect<typeof note>, string | null>>;
type _NullableInsert = Assert<Equal<InferInsert<typeof note>, string | null>>;

// Modifiers compose: `.unique().default()` is unique + insert-optional.
const composed: ColumnValidator<string, string | undefined> = v.string().unique().default("x");

type _ComposedInsert = Assert<Equal<InferInsert<typeof composed>, string | undefined>>;

// `.$type<T>()` overrides both select and insert without touching runtime parsing.
const externalId: ColumnValidator<Id<"users">, Id<"users">> = v.string().$type<Id<"users">>();

type _TypeOverrideSelect = Assert<Equal<InferSelect<typeof externalId>, Id<"users">>>;
type _TypeOverrideInsert = Assert<Equal<InferInsert<typeof externalId>, Id<"users">>>;

// `v.timestamp()` / `v.date()` are epoch-millisecond numbers.
const createdOn: TimestampColumnValidator = v.timestamp();
const dueOn: TimestampColumnValidator = v.date();

type _TimestampSelect = Assert<Equal<InferSelect<typeof createdOn>, number>>;
type _DateSelect = Assert<Equal<InferSelect<typeof dueOn>, number>>;

// `.defaultNow()` leaves select alone but makes insert accept `undefined`.
const startedAt: ColumnValidator<number, number | undefined> = v.timestamp().defaultNow();

type _DefaultNowSelect = Assert<Equal<InferSelect<typeof startedAt>, number>>;
type _DefaultNowInsert = Assert<Equal<InferInsert<typeof startedAt>, number | undefined>>;

// --- $inferSelect vs $inferInsert divergence over a table shape ---------------

const shape: {
    archived: ColumnValidator<boolean, boolean | undefined>;
    createdAt: ColumnValidator<number, number | undefined>;
    note: ColumnValidator<string | null, string | null>;
    priority: ColumnValidator<string, string | undefined>;
    projectId: ColumnValidator<Id<"projects">, Id<"projects">>; // secret-scanner:allow -- a schema field name in a type-level test, not a credential
    title: ColumnValidator<string, string>;
} = {
    archived: v.boolean().default(false),
    createdAt: v.number().$defaultFn(() => Date.now()),
    note: v.string().nullable(),
    priority: v.string().default("medium"),
    projectId: v.id("projects"),
    title: v.string().unique(),
};

// Select: every field required; `note` carries the `| null`.
type _SelectShape = Assert<
    Equal<
        SelectShape<typeof shape>,
        {
            archived: boolean;
            createdAt: number;
            note: string | null;
            priority: string;
            projectId: Id<"projects">;
            title: string;
        }
    >
>;

// Insert: defaulted columns become optional keys; everything else stays required.
// `note` is nullable but not defaulted, so it stays required as `string | null`.
type _InsertOptionalKeys = Assert<Equal<OptionalKeys<InsertShape<typeof shape>>, "archived" | "createdAt" | "priority">>;
type _InsertRequiredKeys = Assert<Equal<RequiredKeys<InsertShape<typeof shape>>, "note" | "projectId" | "title">>;
type _InsertNoteType = Assert<Equal<InsertShape<typeof shape>["note"], string | null>>;
type _InsertPriorityType = Assert<Equal<NonNullable<InsertShape<typeof shape>["priority"]>, string>>;

export type {
    _ComposedInsert,
    _DateSelect,
    _DefaultFunctionInsert as _DefaultFnInsert,
    _DefaultFunctionSelect as _DefaultFnSelect,
    _DefaultInsert,
    _DefaultNowInsert,
    _DefaultNowSelect,
    _DefaultSelect,
    _InsertNoteType,
    _InsertOptionalKeys,
    _InsertPriorityType,
    _InsertRequiredKeys,
    _NullableInsert,
    _NullableSelect,
    _OnUpdateInsert,
    _SelectShape,
    _ServerDefaultInsert,
    _ServerDefaultSelect,
    _TimestampSelect,
    _TypeOverrideInsert,
    _TypeOverrideSelect,
    _UniqueInsert,
    _UniqueSelect,
};
