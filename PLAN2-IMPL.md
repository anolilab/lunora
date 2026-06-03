# Cirrus — Plan 2 Implementation Spec: Phase A (Keystone)

**Status 2026-06-03: COMPLETE.** This Phase-A spec (builder + ORM) shipped; the "seams left for later" (relations, triggers, aggregates, RLS) have since been implemented too. Retained as historical design record.

Code-level spec for the two foundational items from [PLAN2.md](./PLAN2.md):

- **1.1 — cRPC-style procedure builder + middleware** (`@cirrus/server`, `@cirrus/codegen`)
- **1.2 — Drizzle/Prisma-style ORM query layer + column modifiers + constraints** (`@cirrus/values`, `@cirrus/do`, `@cirrus/d1`, `@cirrus/codegen`)

Out of scope here (separate specs): relations (1.3), triggers/lifecycle (1.4), online data migrations (1.5). Where 1.2 touches those, it leaves seams, not implementations.

**Grounding (current source read).** Dispatch is fixed and must be preserved:

- `query/mutation/action` (`packages/server/src/functions.ts:71-78`) return `RegisteredFunction<A,R,Kind> = { kind, args, handler }` (`packages/server/src/types.ts:81-89`). `handler` is positional `(context, args) => R` and runs `validateArgs` then the user handler (`functions.ts:58-69`).
- Codegen discovers `export const x = query({...})` by AST-matching an **identifier** callee imported from `@cirrus/server`, reading `args` + `handler` from the object literal (`packages/codegen/src/discover-functions.ts:85-106,116-182,247-289`) → `FunctionIR` (`packages/codegen/src/ir.ts:64-77`).
- Emit builds `CIRRUS_FUNCTIONS[":ns:fn"] = registered` and the DO calls `registered.handler(this.buildCtx(), args)` (`packages/codegen/src/emit.ts:300-329,466-502`).
- The in-DO data layer is JSON-blob + `json_extract` expression indexes; reads go through `buildReader` (`packages/do/src/ctx-db.ts:225-321`), writes through `createShardCtxDb` (`:363-471`), schema via `runShardMigrations` (`:481-504`). Global (`.global()`) tables live in D1 and are skipped in the DO.

**Hard invariant for both items:** the generated `CIRRUS_FUNCTIONS` entry stays `{ kind, args, handler:(ctx,args)=>R }`. The builder and ORM change _authoring_ and _compilation_, never the dispatch contract. This keeps `@cirrus/runtime` and the DO `handleRpc` untouched.

**Decisions locked (2026-05-28):**

1. **Terminal method names the kind** — `.query()`/`.mutation()`/`.action()`, not a generic `.handler()`. Codegen reads the kind from a local AST node; no cross-file builder tracing. (Detail in 1.1.1 / 1.1.5.)
2. **Column modifiers extend `v.*`** — `.default()`/`.unique()`/`.$defaultFn()`/`.$onUpdateFn()`/`.nullable()` hang off the existing validator factories; no parallel Drizzle-style `text()/number()` builder set, no second codegen parser. (Detail in 1.2.5.)

---

# 1.1 — Procedure builder + middleware

## 1.1.1 Target authoring API

```ts
// cirrus/lib/functions.ts — created once per app
import { initCirrus, CirrusError } from "@cirrus/server";
import type { DataModel } from "../_generated/dataModel";

const c = initCirrus.dataModel<DataModel>().create();

export const publicQuery = c.query;
export const publicMutation = c.mutation;
export const publicAction = c.action;

// reusable auth middleware — extends ctx with a non-null userId
export const authedQuery = c.query.use(async ({ ctx, next }) => {
    const id = await ctx.auth.getIdentity();
    if (!id) throw new CirrusError("UNAUTHORIZED");
    return next({ ctx: { userId: id.sub as string, identity: id } });
});
```

```ts
// cirrus/messages.ts — per-function authoring
import { v } from "@cirrus/server";
import { authedQuery } from "./lib/functions";

export const list = authedQuery.input({ channelId: v.id("channels") }).query(async ({ ctx, args }) => {
    // ctx.userId is string (narrowed by middleware); args.channelId is Id<"channels">
    return ctx.db.messages.findMany({ where: { channelId: args.channelId } });
});
```

**Key decisions (and why):**

1. **Kind bound at the base builder** (`c.query`/`c.mutation`/`c.action`), and the **terminal method re-states the kind** (`.query()`/`.mutation()`/`.action()`). Codegen reads kind from the terminal method name — a purely local AST read, no cross-file symbol tracing to learn that `authedQuery` is a query. This is the single most important design choice for keeping codegen simple and is why we do **not** use a generic `.handler()` terminal.
2. **Handler takes one destructured object** `({ ctx, args }) => R` (not positional `(ctx, args)`), because middleware-extended `ctx` is the whole point and a named param reads better.
3. **`.input()` is additive and may be called multiple times** (merged), matching tRPC; arg validators accumulate.
4. **Backward compatible.** The flat `query({args,handler})` / `mutation` / `action` keep working unchanged. Codegen gains a second discovery path; both coexist so migration is opt-in, file-by-file.

## 1.1.2 New types (`packages/server/src/builder/types.ts`)

```ts
import type { ArgsValidator, InferArgs, ActionCtx, MutationCtx, QueryCtx } from "../types.js";

/** next() with no arg passes ctx through; with { ctx } shallow-merges an extension. */
export interface MiddlewareNext<CtxIn> {
    (): Promise<CtxIn>;
    <Ext extends Record<string, unknown>>(opts: { ctx: Ext }): Promise<CtxIn & Ext>;
}

export type Middleware<CtxIn, CtxOut> = (opts: { ctx: CtxIn; next: MiddlewareNext<CtxIn> }) => Promise<CtxOut> | CtxOut;

export type TerminalKind = "action" | "mutation" | "query";

/** Phantom brand so codegen can identify a builder via the type checker (see 1.1.5). */
declare const BRAND: unique symbol;

export interface ProcedureBuilder<Kind extends TerminalKind, Ctx, Args extends ArgsValidator> {
    readonly [BRAND]: "cirrus.procedure";
    input: <A extends ArgsValidator>(validators: A) => ProcedureBuilder<Kind, Ctx, Args & A>;
    use: <CtxOut>(mw: Middleware<Ctx, CtxOut>) => ProcedureBuilder<Kind, CtxOut, Args>;
}

/** The terminal method is named per-kind so only the matching one is exposed. */
export type QueryBuilder<Ctx, Args extends ArgsValidator> = ProcedureBuilder<"query", Ctx, Args> & {
    query: <R>(h: (o: { ctx: Ctx; args: InferArgs<Args> }) => R | Promise<R>) => RegisteredQuery<Args, Awaited<R>>;
};
export type MutationBuilder<Ctx, Args extends ArgsValidator> = ProcedureBuilder<"mutation", Ctx, Args> & {
    mutation: <R>(h: (o: { ctx: Ctx; args: InferArgs<Args> }) => R | Promise<R>) => RegisteredMutation<Args, Awaited<R>>;
};
export type ActionBuilder<Ctx, Args extends ArgsValidator> = ProcedureBuilder<"action", Ctx, Args> & {
    action: <R>(h: (o: { ctx: Ctx; args: InferArgs<Args> }) => R | Promise<R>) => RegisteredAction<Args, Awaited<R>>;
};
```

The `use` overload infers `CtxOut` from the middleware's return type. When the user writes `return next({ ctx: { userId } })`, that expression's type is `Ctx & { userId: string }`, so the builder's ctx advances to exactly that. Short-circuiting middleware (e.g. throwing on auth failure) still type-checks because it returns the `next()` result type on the success path.

## 1.1.3 Runtime (`packages/server/src/builder/index.ts`)

The builder accumulates `{ argsValidators, middlewares[] }` immutably (each `.input`/`.use` returns a fresh object). The terminal wraps everything into the **existing positional `RegisteredFunction` shape**:

```ts
import { validateArgs } from "../functions.js"; // export it (currently module-private)

const runMiddleware = async (mws: Middleware<any, any>[], baseCtx: unknown): Promise<unknown> => {
    let lastIndex = -1;
    const dispatch = async (i: number, ctx: unknown): Promise<unknown> => {
        if (i <= lastIndex) throw new Error("middleware next() called multiple times");
        lastIndex = i;
        const mw = mws[i];
        if (!mw) return ctx; // chain exhausted → final ctx
        return mw({
            ctx,
            next: ((opts?: { ctx?: Record<string, unknown> }) => dispatch(i + 1, opts?.ctx ? { ...(ctx as object), ...opts.ctx } : ctx)) as MiddlewareNext<any>,
        });
    };
    return dispatch(0, baseCtx);
};

const makeTerminal =
    (kind: TerminalKind, args: ArgsValidator, mws: Middleware<any, any>[]) => (userHandler: (o: { ctx: unknown; args: unknown }) => unknown) => ({
        kind,
        args,
        handler: async (context: unknown, rawArgs: Record<string, unknown>) => {
            const parsed = validateArgs(args, rawArgs); // reuse functions.ts validator
            const ctx = await runMiddleware(mws, context); // base ctx → extended ctx
            return userHandler({ ctx, args: parsed });
        },
    });
```

`initCirrus.dataModel<DM>().create(opts?)` returns `{ query, mutation, action }`, each a fresh builder with `kind` bound, `args = {}`, `mws = []`. `.input` merges validators; `.use` appends a middleware; `.query/.mutation/.action` call `makeTerminal`. `dataModel<DM>()` only parameterizes ctx types (typed `db`); it has no runtime effect.

**Insertion points:**

- `packages/server/src/functions.ts:9` — `export` the `validateArgs` helper (currently const, module-private) so the builder reuses one validator implementation.
- `packages/server/src/index.ts:2` — add `export { initCirrus } from "./builder/index.js"` and `export { CirrusError } from "./error.js"`, plus the builder/middleware types.

## 1.1.4 `CirrusError` taxonomy (`packages/server/src/error.ts`)

Aligns with the structural convention the runtime already maps (`{ name: "CirrusError", code, status }` — see `discover-functions.ts:304-309`, `emit.ts:321-325`):

```ts
const CODE_STATUS = {
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    UNPROCESSABLE: 422,
    TOO_MANY_REQUESTS: 429,
    INTERNAL_SERVER_ERROR: 500,
    NOT_IMPLEMENTED: 501,
} as const;
export type CirrusErrorCode = keyof typeof CODE_STATUS;

export class CirrusError extends Error {
    readonly name = "CirrusError";
    readonly code: CirrusErrorCode;
    readonly status: number;
    constructor(code: CirrusErrorCode, message?: string) {
        super(message ?? code);
        this.code = code;
        this.status = CODE_STATUS[code];
    }
}
```

The runtime's existing structural error mapper already turns `name:"CirrusError" + status` into the right HTTP/RPC response, so no runtime change is needed — just confirm the mapper reads `status` (it does, per the 404 path).

## 1.1.5 Codegen changes (`packages/codegen/src/discover-functions.ts`)

Add a **second discovery branch** alongside the existing identifier-callee path (`:260-288`). Both run; a declaration matches at most one.

Today the matcher requires `Node.isIdentifier(callee)` (`:270`). The builder form's initializer is a `CallExpression` whose callee is a **PropertyAccessExpression** ending in `.query`/`.mutation`/`.action`:

```
authedQuery.input({...}).use(...).query(handler)
└─ root ──┘                        └ terminal CallExpression, callee = PropertyAccess ".query"
```

New helper `discoverBuilderProcedure(declaration, call)`:

1. **Terminal kind.** `callee` is `PropertyAccessExpression`; `callee.getName()` ∈ {`query`,`mutation`,`action`} → that's the kind. Else skip.
2. **Brand guard (avoids false positives).** Get the type of the terminal's _receiver_ (`callee.getExpression().getType()`) and require a property whose name matches the phantom brand from 1.1.2 (emit it as a stable string key, e.g. `__cirrusProcedure`, rather than a `unique symbol`, so `type.getProperty("__cirrusProcedure")` resolves across files). If absent → skip. This replaces the `@cirrus/server`-import check used by the identifier path and works through aliases/cross-file re-exports.
3. **Args.** Walk the call chain leftward (`callee.getExpression()` repeatedly). For every `.input(objLiteral)` call, run the existing `parseObjectShape` (`parse-validator.ts`) and merge into one `Record<string, ValidatorIR>` (later keys win, matching runtime merge).
4. **Return type.** Read the terminal call's first argument (the arrow/function handler). It's now `({ctx, args}) => R`, a single destructured param — extract its call signature's return type and unwrap one `Promise<…>`, reusing the exact logic in `returnTypeFromCall` (`:135-181`). Refactor that Promise-unwrap + unreachable-local-type guard into a shared `unwrapHandlerReturn(arrowNode)` used by both paths.
5. Push the same `FunctionIR` shape (`ir.ts:64-77`) — `{ args, exportName, filePath, kind, returnType }`. **No IR change**, so `emit.ts` and the namespace-collision guard (`:297-313`) work unchanged.

`FUNCTION_KINDS` (`:11`) is reused for the terminal-name check.

**Emit: no change.** The builder's `RegisteredFunction` is structurally identical to the flat form, so `CIRRUS_FUNCTIONS`, `dispatchRun`, and `handleRpc` are untouched.

## 1.1.6 Test plan (1.1)

- `packages/server/__tests__/builder.test.ts`
    - middleware onion order; `next({ctx})` merges and narrows; double-`next()` throws.
    - short-circuit: middleware throwing `CirrusError("UNAUTHORIZED")` aborts before handler; `.status===401`.
    - `.input` merge across multiple calls; arg validation rejects bad args with `args.<field>` path (parity with `functions.ts` path-prefixing).
    - terminal output is structurally `{kind,args,handler}` and `handler(ctx,args)` runs validate→mw→handler.
    - **type tests** (`builder.types.test-d.ts` / `expectTypeOf`): ctx narrowing after `.use`; `args` typed from `.input`; wrong terminal not present on a query builder (`c.query.mutation` is a type error).
- `packages/codegen/__tests__/discover-functions.test.ts`
    - chained builder discovered with correct kind/args/returnType; brand guard rejects a look-alike chain on a non-builder object; flat + builder forms in the same project both emit; aliased re-exported builder still discovered.
- Integration: existing `emit`/dispatch tests pass unchanged (proves the invariant).

---

# 1.2 — ORM query layer + column modifiers + constraints

Scope: typed `where` / `orderBy` / cursor pagination / `count`, column modifiers (`.default`, `.unique`, `.$defaultFn`, `.$onUpdateFn`, nullability) with insert/select type inference, and constraint enforcement (notNull, unique). Compiles to **two dialects**: JSON-blob `json_extract` (DO/shard-local) and column SQL (D1/global). **Relations and triggers are explicitly deferred** (1.3/1.4) — the compiler is structured so they slot in later.

## 1.2.1 Target authoring + query API

```ts
// schema.ts — column modifiers on the existing v.* factories
export const schema = defineSchema({
    todos: defineTable({
        title: v.string().unique(),
        projectId: v.id("projects"),
        priority: v.string().default("medium"), // optional on insert
        createdAt: v.number().$defaultFn(() => Date.now()), // optional on insert
        updatedAt: v.number().$onUpdateFn(() => Date.now()),
        archived: v.boolean().default(false),
        note: v.string().nullable(), // string | null
    }).index("by_project", ["projectId"]),
});
```

```ts
// query surface inside a handler
const page = await ctx.db.todos.findMany({
    where: { projectId, priority: { in: ["high", "medium"] }, archived: false },
    orderBy: [{ createdAt: "desc" }],
    limit: 20,
    cursor, // opaque keyset cursor from a prior page
});
// → { page: Doc<"todos">[], continueCursor: string | null, isDone: boolean }

const one = await ctx.db.todos.findFirst({ where: { title: "Launch" } });
const total = await ctx.db.todos.count({ where: { projectId } });
```

`ctx.db.<table>` is a **codegen-emitted typed facade** over a structural runtime (1.2.4). The legacy `ctx.db.query("todos").withIndex(...).take()` (`types.ts:102-108`) stays for back-compat.

## 1.2.2 `where` DSL + compiler

```ts
type Op<T> = { eq?: T; ne?: T; in?: T[]; notIn?: T[]; lt?: T; lte?: T; gt?: T; gte?: T; isNull?: boolean; contains?: string /* string fields */ };
type Where<Doc> = { [K in keyof Doc]?: Doc[K] | Op<Doc[K]> } & { AND?: Where<Doc>[]; OR?: Where<Doc>[]; NOT?: Where<Doc> };
```

New `where-clause-compiler.ts` shared by both dialects via a `FieldRef` strategy:

- **DO dialect** (`@cirrus/do`): `field → jsonPath(field)` (reuses `ctx-db.ts:140-153`), values via `serializeSqlValue` (`:323-337`). Leaf → `json_extract(__doc__,'$.f') <op> ?`; `in` → `IN (?,?,…)`; `isNull:true` → `IS NULL`; `contains` → `LIKE '%'||?||'%'`. `AND`/`OR`/`NOT` recurse into parenthesized groups, accumulating an ordered param array.
- **D1 dialect** (`@cirrus/d1`): `field → quoteIdentifier(field)` (real columns), same operator emission. This is why global tables need column-per-field physical schema (see 1.2.6).

Output: `{ sql: string, params: unknown[] }`. The compiler is pure (no I/O) → unit-testable in isolation. Branching point for RLS (3.2) later: an injected `baseWhere` AND-merged before compilation.

## 1.2.3 `orderBy` + keyset cursor pagination

- `orderBy: { field: "asc"|"desc" }[]` → `ORDER BY <ref> ASC/DESC, …`, always appending a stable `id` tiebreak. Replaces the hardcoded order in `runFetch` (`ctx-db.ts:254-257`).
- **Index awareness:** if `orderBy` (or `where` equality fields) prefix-matches a declared index, rely on that expression index; else SQLite/D1 sorts. (Cirrus already creates expression indexes per declared index — `:495-501`.)
- **Cursor = keyset, not offset.** `continueCursor` is base64(JSON) of the last row's `orderBy` values + `id`. Next page AND-merges a seek predicate: for `orderBy [a ASC, b DESC]`, `(a > ?) OR (a = ? AND b < ?) OR (a = ? AND b = ? AND id > ?)`. Returns `{ page, continueCursor: page.length===limit ? encode(last) : null, isDone: page.length<limit }`. Keyset avoids the O(offset) scan and is correct under concurrent inserts.

## 1.2.4 Runtime methods (`packages/do/src/ctx-db.ts`)

Extend `DatabaseWriterLike` (`:120-127`) and `buildReader` with:

```ts
findMany(table: string, q: QueryArgs): Promise<Record<string, unknown>[]>;       // applies where/orderBy/limit+1 for cursor
findFirst(table: string, q: QueryArgs): Promise<Record<string, unknown> | null>;
count(table: string, where?: WhereInput): Promise<number>;                       // SELECT COUNT(*) … WHERE …
```

`findMany` builds SQL via the where-compiler + orderBy + `LIMIT n+1` (to compute `isDone` without a second query), then `rowToDoc` maps results (`:155-184`). `count` is `SELECT COUNT(*)` — not row enumeration (note: true O(1) aggregate counts are 3.1, out of scope; this is an honest COUNT scan bounded by `where`). Legacy `query()/withIndex/filter/take` stays.

The D1 variant lives in `@cirrus/d1` (`d1-client.ts`) with the column dialect, exposing the same three methods so the codegen facade is backend-agnostic.

## 1.2.5 Column modifiers (`packages/values/src/v.ts`)

Extend the validators **used inside `defineTable`** with a chainable modifier API while keeping them assignable to `Validator` (so arg-position usage and existing codegen `kind` reads are unaffected). Add an internal `_meta.column` payload:

```ts
interface ColumnMeta {
    notNull: boolean; // default true; .nullable() flips it
    unique?: boolean;
    defaultValue?: unknown; // .default(v)
    defaultFn?: () => unknown; // .$defaultFn(fn)
    onUpdateFn?: () => unknown; // .$onUpdateFn(fn)
}
```

The factories (`v.string()`, `v.number()`, …) return `Validator<T> & ColumnModifiers<T>` where each modifier returns a new validator carrying updated `_meta.column`. Type-level, `.default()`/`.$defaultFn()` flip the field to **optional on insert** and `.nullable()` widens select to `T | null`. Introduce phantom `Column<TSelect, TInsert>` so `defineTable` can derive `$inferInsert`/`$inferSelect`.

**Decision & tradeoff:** extend `v.*` rather than add a parallel Drizzle-style `text()/number()` builder set. Rationale: Cirrus is Convex-flavoured (`v.*` is the established vocabulary, codegen already parses it via `parse-validator.ts`, and arg validators reuse the same factories). The cost is that `v.string()` now carries column-only methods that are meaningless in arg position — documented as no-ops there. The alternative (separate column builders) was rejected to avoid two type systems and a second codegen parser.

**Codegen** (`parse-validator.ts` + `ir.ts`): extend `ValidatorIR` with an optional `column?: ColumnMeta` and read `_meta.column` during schema discovery so emitted `dataModel.ts` reflects insert/select optionality. Arg discovery ignores it.

## 1.2.6 Constraint enforcement

- **notNull / nullable:** enforced at validate time (required validators already reject `undefined`; `.nullable()` allows `null`). No runtime change beyond honoring `_meta.column.notNull` in the emitted insert type.
- **default / $defaultFn:** applied in the **write layer** (`createShardCtxDb.insert`, `ctx-db.ts:389-411`) — before persisting, fill any missing field that has `defaultValue`/`defaultFn`. Requires `createShardCtxDb` to receive column metadata; today it gets `SchemaLike` with only `{ indexes, shape:{kind}, shardMode }` (`ctx-db.ts:55-69`). Widen `ValidatorLike` (`:67-69`) to optionally carry `column?: ColumnMeta`, populated by the generated `shard.ts` (which imports the real schema).
- **$onUpdateFn:** applied in `patch`/`replace` (`:413-454`) — set the field when not explicitly provided.
- **unique:** column `.unique()` auto-creates a `UNIQUE` expression index in `runShardMigrations` (`:495-501` already supports `index.unique`); just synthesize an index entry from the column meta. SQLite/D1 raise on violation → catch in the write layer and rethrow as `CirrusError("CONFLICT")` (ties to 1.1.4). Note the documented Convex/kitcn rule: raw `ctx.db` writes bypass ORM-level checks — keep that boundary (defaults/unique-mapping live on the typed `ctx.db.<table>` path; legacy `db.insert` stays low-level).

## 1.2.7 Codegen facade (`packages/codegen/src/emit.ts`)

Emit a typed `ctx.db.<table>` facade in the generated server/dataModel output: for each table, `{ findMany(q): Promise<{page: Doc<T>[]; continueCursor: string|null; isDone: boolean}>; findFirst(q): Promise<Doc<T>|null>; count(where?): Promise<number>; get(id); insert(values); patch(id, p); delete(id) }`, with `where`/`orderBy` typed against the table's columns and insert/select types derived from `Column<>` inference. The facade is a thin typed wrapper over the structural runtime methods (1.2.4), selected by `shardMode` (DO vs D1 backend) at generation time.

## 1.2.8 Test plan (1.2)

- `packages/do/__tests__/where-clause-compiler.test.ts` — every operator; AND/OR/NOT nesting → exact SQL + ordered params; `in []` edge; `contains` LIKE escaping; both dialects (json_extract vs column) from one fixture.
- `packages/do/__tests__/ctx-db.findMany.test.ts` (real SQLite per AGENTS.md — no mocks) — where filtering; multi-field orderBy + asc/desc; keyset cursor round-trips and is stable across an interleaved insert; `isDone`/`continueCursor` boundaries; `count` matches `where`.
- `packages/values/__tests__/column.types.test-d.ts` — `.default()`/`.$defaultFn()` make insert field optional; `.nullable()` widens select to `T|null`; `$inferInsert` vs `$inferSelect` divergence.
- `packages/do/__tests__/ctx-db.constraints.test.ts` — default applied on insert; `$onUpdateFn` on patch/replace but not when field explicitly set; unique violation → `CirrusError("CONFLICT")` (status 409).
- `packages/d1/__tests__/` — same query/constraint suite against the column dialect (real D1/SQLite).
- `packages/codegen/__tests__/emit.test.ts` — facade types reflect column optionality; DO vs D1 backend selection by `shardMode`.

---

# Sequencing within Phase A

```
A1  CirrusError (1.1.4)              ← zero deps, unblocks everything
A2  export validateArgs (1.1.3 dep)
A3  builder runtime + types (1.1.2/1.1.3)
A4  codegen builder discovery (1.1.5) + refactor unwrapHandlerReturn
    ── 1.1 shippable; flat API still works ──
A5  column modifiers + meta (1.2.5) + IR/parse-validator
A6  where-compiler (1.2.2), two dialects
A7  ctx-db findMany/findFirst/count + keyset cursor (1.2.3/1.2.4)
A8  constraint enforcement in write layer (1.2.6)
A9  D1 dialect parity (1.2.4/1.2.6)
A10 codegen typed db facade (1.2.7)
    ── 1.2 shippable ──
```

A1–A4 (the builder) are independent of A5–A10 (the ORM) and can land in parallel branches. Both preserve the `{kind,args,handler}` dispatch invariant, so `@cirrus/runtime` and the DO `handleRpc` never change.

# Seams left for later tiers

- **Relations (1.3):** the where-compiler takes a single table; relation loading will wrap `findMany` with a second indexed fetch keyed by FK, merged in `rowToDoc`. Cross-shard relations route through the Query Coordinator — not added here.
- **Triggers (1.4):** the existing `onWrite` hook (`ctx-db.ts:93-99,408-466`) is the attach point; lifecycle hooks become typed `onWrite` subscribers fired inside the DO transaction.
- **Aggregates (3.1):** `count()` here is an honest `COUNT(*)` scan; the O(1) `aggregateIndex` path replaces it later without changing the call site.
- **RLS (3.2):** the where-compiler's injectable `baseWhere` is the row-filter hook; middleware (1.1) supplies the policy context.
