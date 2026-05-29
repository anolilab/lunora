/**
 * Compile-time only: exercised by `tsc --noEmit` via the package tsconfig's
 * `__tests__/**` include. Asserts the insert/select type divergence produced by
 * the column-modifier API (`.default`, `.$defaultFn`, `.unique`, `.nullable`).
 */
import type { Id, InferInsert, InferSelect, InsertShape, SelectShape } from "../src/index.js";
import { v } from "../src/index.js";

type Assert<T extends true> = T;
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];

// --- scalar modifiers ---------------------------------------------------------

// `.default(value)` leaves select alone but makes insert accept `undefined`.
const priority = v.string().default("medium");

export type _DefaultSelect = Assert<Equal<InferSelect<typeof priority>, string>>;
export type _DefaultInsert = Assert<Equal<InferInsert<typeof priority>, string | undefined>>;

// `.$defaultFn(fn)` behaves like `.default` for optionality.
const createdAt = v.number().$defaultFn(() => Date.now());

export type _DefaultFnSelect = Assert<Equal<InferSelect<typeof createdAt>, number>>;
export type _DefaultFnInsert = Assert<Equal<InferInsert<typeof createdAt>, number | undefined>>;

// `.$onUpdateFn(fn)` does NOT make the field optional on insert.
const updatedAt = v.number().$onUpdateFn(() => Date.now());

export type _OnUpdateInsert = Assert<Equal<InferInsert<typeof updatedAt>, number>>;

// `.unique()` is type-transparent.
const title = v.string().unique();

export type _UniqueSelect = Assert<Equal<InferSelect<typeof title>, string>>;
export type _UniqueInsert = Assert<Equal<InferInsert<typeof title>, string>>;

// `.nullable()` widens both select and insert to `T | null`.
const note = v.string().nullable();

export type _NullableSelect = Assert<Equal<InferSelect<typeof note>, string | null>>;
export type _NullableInsert = Assert<Equal<InferInsert<typeof note>, string | null>>;

// Modifiers compose: `.unique().default()` is unique + insert-optional.
const composed = v.string().unique().default("x");

export type _ComposedInsert = Assert<Equal<InferInsert<typeof composed>, string | undefined>>;

// `.$type<T>()` overrides both select and insert without touching runtime parsing.
const externalId = v.string().$type<Id<"users">>();

export type _TypeOverrideSelect = Assert<Equal<InferSelect<typeof externalId>, Id<"users">>>;
export type _TypeOverrideInsert = Assert<Equal<InferInsert<typeof externalId>, Id<"users">>>;

// `v.timestamp()` / `v.date()` are epoch-millisecond numbers.
const createdOn = v.timestamp();
const dueOn = v.date();

export type _TimestampSelect = Assert<Equal<InferSelect<typeof createdOn>, number>>;
export type _DateSelect = Assert<Equal<InferSelect<typeof dueOn>, number>>;

// `.defaultNow()` leaves select alone but makes insert accept `undefined`.
const startedAt = v.timestamp().defaultNow();

export type _DefaultNowSelect = Assert<Equal<InferSelect<typeof startedAt>, number>>;
export type _DefaultNowInsert = Assert<Equal<InferInsert<typeof startedAt>, number | undefined>>;

// --- $inferSelect vs $inferInsert divergence over a table shape ---------------

const shape = {
    archived: v.boolean().default(false),
    createdAt: v.number().$defaultFn(() => Date.now()),
    note: v.string().nullable(),
    priority: v.string().default("medium"),
    projectId: v.id("projects"),
    title: v.string().unique(),
};

// Select: every field required; `note` carries the `| null`.
export type _SelectShape = Assert<
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
export type _InsertOptionalKeys = Assert<Equal<OptionalKeys<InsertShape<typeof shape>>, "archived" | "createdAt" | "priority">>;
export type _InsertRequiredKeys = Assert<Equal<RequiredKeys<InsertShape<typeof shape>>, "note" | "projectId" | "title">>;
export type _InsertNoteType = Assert<Equal<InsertShape<typeof shape>["note"], string | null>>;
export type _InsertPriorityType = Assert<Equal<NonNullable<InsertShape<typeof shape>["priority"]>, string>>;
