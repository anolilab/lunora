/**
 * Evidence the feeders read from function bodies: calls, reads, writes, and the keys and URLs they touch.
 */
import type { AdvisorCallSiteScope } from "@lunora/advisor";

import type { FunctionIR } from "./functions";
import type { WorkflowIR } from "./platform";

/**
 * Who a discovered call site runs on behalf of — the one attribution every
 * per-call-site IR carries (see `discover/attribution`).
 *
 * `export`: lexically inside an exported top-level declaration. `name` is the
 * EXPORTED name — `export const send = …` → `send`, `export default …` →
 * `default`, `const run = …; export { run as start }` → `start`.
 *
 * `helper`: inside a top-level, non-exported `function` / `const` of the same
 * file. `callers` are the exports that reach it through same-file value
 * references (a call, or the helper passed on as a value), transitively and
 * sorted; a type-only reference (`typeof helper`) does not count. Empty for an
 * orphan helper no export reaches. `untracked` is set when code attribution
 * cannot follow — module scope, a class body, a destructured declaration — also
 * reaches the helper, so `callers` is incomplete.
 *
 * `module`: outside every top-level `function` / `const` — module scope, or a
 * class body.
 *
 * A site is recorded once; consumers fan out over its callers. The advisor's
 * `AdvisorCallSiteScope` is the same type, so feeder rows pass straight through.
 */
export type CallSiteScope = AdvisorCallSiteScope;

/**
 * One call-site edge of the architecture graph, attributed through its
 * {@link CallSiteScope}.
 * Exactly one of `target` / `reason` is set: `target` is a `namespace:export`
 * function key (`call` / `schedule`) or a queue / topic export name (`enqueue` /
 * `publish`); `reason` says why the target could not be read statically.
 */
export interface CallEdgeIR {
    /**
     * `true` when the hop may not take effect on every pass of its function —
     * see `conditionOf` in `discover/call-edges.ts` for the rules. Set
     * only, never `false`. The `dispatch_cycle` lint's false-positive gate.
     */
    conditional?: true;

    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;

    kind: "call" | "enqueue" | "invoke" | "publish" | "schedule";
    /** 1-based line of the call. */
    line: number;

    /**
     * `true` alongside `conditional` when a loop's body or update clause is the
     * ONLY thing that may stop the hop — the loop may run zero times, but a
     * queue consumer's `for (const message of batch.messages)` always has a
     * message. Set only, never `false`. The queue cycle lint reads it; the
     * scheduler lints still treat the hop as conditional.
     */
    loopOnly?: true;
    reason?: string;

    /**
     * The facts of a scheduled dispatch, present on `schedule` edges only. `delayMs`
     * is the literal `runAfter` delay (absent for `runAt` or a non-literal delay).
     * `argKeys` are the top-level property names of the dispatch's args object:
     * `[]` when there are no args, and `undefined` when the args are not an object
     * literal (or spread into one), so a lint can tell "no cursor" from "cannot tell".
     */
    schedule?: { argKeys?: string[]; delayMs?: number };
    /** Who the call runs on behalf of. */
    scope: CallSiteScope;
    target?: string;
}

/**
 * A literal-infinite loop in `lunora/` source — `while (true)`, `for (;;)` /
 * `for (; true;)`, `do { … } while (true)` — with no statically reachable way
 * out: no `break` bound to this loop, no `return`/`throw` outside a nested
 * function, no labeled `break` escaping it. One record per offending loop; a
 * loop that can exit records nothing, so the `unbounded_loop` lint has no
 * bounded loop to sift through.
 */
export interface UnboundedLoopIR {
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** The loop form that never falls out. */
    kind: "do" | "for" | "while";
    /** 1-based line of the `loop` keyword. */
    line: number;
    /** Who the loop runs on behalf of. */
    scope: CallSiteScope;
}

/**
 * A `ctx.workflows.get("name")…` call discovered in a function body — the
 * use-site analog of {@link WorkflowIR} (which is the declaration side). Feeds
 * the `workflow_unused` lint (a declared workflow with zero call sites) and the
 * `workflow_unknown_target` lint (a `.get("x")` whose `x` isn't declared — a
 * typo catcher). {@link WorkflowCallIR.workflow} is `""` when the `get(...)`
 * argument is not a string literal (a dynamic name — which suppresses the
 * unused-workflow heuristic rather than producing a false positive).
 */
export interface WorkflowCallIR {
    /** Source file relative to `<projectRoot>/lunora/`, without extension (the api namespace). */
    file: string;
    /** 1-based line of the `get(...)` call. */
    line: number;
    /** Who the call runs on behalf of. */
    scope: CallSiteScope;
    /** The referenced workflow export name, or `""` when the argument is not a string literal. */
    workflow: string;
}

/**
 * A `ctx.db.count("table", …)` or `ctx.db.<table>.count(…)` call discovered in a
 * function body. `count()` is answered from a counter only when the table declares an
 * aggregate index (`TableIR.aggregateIndexed`); otherwise it runs `COUNT(*)` over the
 * table. `indexed` is `false` exactly for that scan, so the `count_without_index` lint
 * reports only those; an unknown table or a dynamic name reads as `indexed: true`.
 */
export interface CountReadIR {
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** `false` only when the table is known and declares no aggregate index. */
    indexed: boolean;
    /** 1-based line of the `count(...)` call. */
    line: number;
    /** Who the call runs on behalf of. */
    scope: CallSiteScope;
    /** Counted table name, or `""` when the table argument is not a string literal. */
    table: string;
}

/**
 * A `ctx.db.query("table")…` read discovered in a function body, reduced to what
 * the query advisor lints need: which table, whether the chain narrows with an
 * index, whether it filters, and which terminal materializes the result.
 * `table` is `""` when the `query(...)` argument is not a string literal (a
 * dynamic table — not lintable).
 */
export interface QueryReadIR {
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;

    /**
     * The fields the chain's `.filter()` predicate reads off its row parameter
     * (`(r) => r.a < cutoff && r.b === x` → `["a", "b"]`). `undefined` when the
     * chain has no filter or the predicate is not a function literal. Optional so
     * a feeder predating this field still typechecks.
     */
    filterFields?: string[];

    /**
     * True when the chain's `.filter()` predicate compares `_id`
     * (`(d) => d._id === args.id`) — a full scan for a row that `ctx.db.get`
     * addresses directly. Optional so a feeder predating this field still
     * typechecks; absent is treated as "not a primary-key filter".
     */
    filtersPrimaryKey?: boolean;
    /** The chain calls `.filter(...)`. */
    hasFilter: boolean;
    /** The chain narrows with `.withIndex(...)` or `.withSearchIndex(...)`. */
    hasIndex: boolean;

    /**
     * The chain's `.withIndex(…)`, present exactly when the chain has one. `name` is
     * the literal index name, or `undefined` when it is not a string literal.
     * `bounds` are the comparators its range callback calls on the index parameter,
     * sorted and de-duplicated: `[]` for a bare `.withIndex(name)` (the widest range),
     * `undefined` when the callback exists but cannot be read.
     */
    index?: { bounds?: string[]; name?: string };
    /** 1-based line of the `query(...)` call. */
    line: number;
    /** Who the read runs on behalf of. */
    scope: CallSiteScope;
    /** Queried table name, or `""` when the argument is not a string literal. */
    table: string;

    /**
     * The materializing call the chain ends in — `"collect"`, `"take"`,
     * `"paginate"`, `"first"`, `"unique"`, … — i.e. how much of the narrowed set
     * the read actually loads.
     *
     * `undefined` when the chain reaches no recognised terminal (a reader passed
     * on, a bare `query(...)`) AND when a feeder predating this field produced
     * the read. The two are deliberately not distinguished: no consumer could act
     * on the difference, so the terminal-shaped lints skip the read either way
     * rather than guessing a terminal.
     */
    terminal?: string;

    /**
     * Visibility of the procedure the read runs on behalf of: `internal` when every
     * caller is internal, `public` when any caller is public. Stamped from the
     * registered functions, so it is absent when the feeder could not read them.
     */
    visibility?: "internal" | "public";
}

/**
 * A `ctx.authApi.<method>(...)` call discovered in a function body, attributed
 * to the exported function (and its file = api namespace) that performs it.
 * Structurally identical to `AdvisorAuthApiCall` so it passes straight through
 * to the advisor lint without conversion, exactly as `InsertWriteIR` does for
 * `AdvisorInsertWrite`.
 */
export interface AuthApiCallIR {
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** True when the call's argument object includes a `headers` property. */
    hasHeaders: boolean;
    /** 1-based line of the call, or `0` when unknown. */
    line: number;
    /** The better-auth method invoked (e.g. `banUser`); empty when not statically known. */
    method: string;
    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;
}

/**
 * A table write other than a plain `ctx.db.insert(...)` (see {@link InsertWriteIR}):
 * a by-id `patch`/`replace`/`delete`/`hardDelete`/`restore`, a batch write, or a
 * `ctx.db.<table>.*` facade write. Feeds the architecture manifest's `write`
 * edges and the `cross_module_table_write` lint.
 */
export interface TableWriteIR {
    /**
     * The fields a `patch` / `patchMany` writes, read off its object-literal
     * argument. `undefined` for every other method, and for a patch whose
     * argument is not an object literal or spreads one: the feeder then cannot
     * say which fields change.
     */
    fields?: string[];
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the call. */
    line: number;
    /** The writer method called, e.g. `patch`, `deleteMany`, `upsert`. */
    method: string;

    /** Who the write runs on behalf of. */
    scope: CallSiteScope;

    /**
     * Target table; `""` when it can't be read (an untyped id, a non-literal
     * name). A union id (`Id<"a"> | Id<"b">`) gives one record per table.
     */
    table: string;
}

/**
 * A row-changing write a function performs directly or through the functions it
 * reaches, attributed to the EXPORT that reaches it. A write in a helper in
 * another file is included under the export that calls the helper, so a sweep
 * that deletes through a helper counts as progress. The fields follow
 * {@link TableWriteIR.fields}.
 */
export interface RowEffectIR {
    /** The export the write is reachable from. */
    exportName: string;
    /** See {@link TableWriteIR.fields}. */
    fields?: string[];
    /** Source file of that export, relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** The write method, as on {@link TableWriteIR.method}. */
    method: string;
    /** The table the write targets. Never `""`: an unreadable table is not evidence of progress. */
    table: string;
}

/**
 * A `ctx.db.insert("table", …)` write discovered in a function body, attributed
 * to the exported function (and its file = api namespace) that performs it — the
 * write-side analog of {@link QueryReadIR}. Lets tooling wire a table's write
 * action by behavior (which function inserts into it) rather than by naming.
 * {@link InsertWriteIR.table} is `""` when the argument is not a string literal.
 */
export interface InsertWriteIR {
    /** Source file relative to `<projectRoot>/lunora/`, without extension (the api namespace). */
    file: string;
    /** 1-based line of the `insert(...)` call. */
    line: number;
    /** Who the insert runs on behalf of. */
    scope: CallSiteScope;
    /** Target table name, or `""` when the argument is not a string literal. */
    table: string;
}

/**
 * A non-deterministic API call (`Date.now`, `Math.random`, `crypto.randomUUID`,
 * `crypto.getRandomValues`, `fetch`) discovered lexically inside a `query(...)`
 * or `mutation(...)` handler body — the `nondeterministic_query_mutation` lint
 * input. Structurally identical to `AdvisorNondeterministicCall` so values pass
 * straight through to the advisor without conversion, exactly as `AuthApiCallIR`
 * does for `AdvisorAuthApiCall`. `action(...)` handlers are never recorded —
 * actions are the determinism escape hatch.
 */
export interface NondeterministicCallIR {
    /** The non-deterministic API invoked, e.g. `Date.now` / `Math.random` / `crypto.randomUUID` / `fetch`. */
    callee: string;
    /** Export binding name of the function performing the call, e.g. `sendMessage`. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension (the api namespace). */
    file: string;
    /** Which procedure kind the call lives in — only `query`/`mutation` handlers are recorded. */
    kind: "mutation" | "query";
    /** 1-based line of the call, or `0` when unknown. */
    line: number;
}

/**
 * One `ctx.<property>` access lexically inside a `query`/`mutation` handler —
 * the feeder shape behind every "action-only surface used outside an action"
 * advisor lint (`hyperdrive_outside_action` for `ctx.sql`,
 * `r2sql_outside_action` for `ctx.r2sql`). Structurally identical to the
 * advisor's `AdvisorHyperdriveCall` / `AdvisorR2sqlCall` (same field set) so
 * values pass straight through `lintSchema` without conversion, exactly as
 * {@link NondeterministicCallIR} does. Only `query`/`mutation` handlers are
 * recorded; `action(...)` is the only context where these surfaces are even
 * typed, so it is the intended home and is skipped.
 */
export interface ContextPropertyCallIR {
    /** The accessed surface, e.g. `ctx.sql.query` / `ctx.r2sql.from` — the property, suffixed with the method when one is called on it. */
    callee: string;
    /** Export binding name of the function performing the access. */
    exportName: string;
    /** Source file relative to the lunora dir, without extension (the api namespace). */
    file: string;
    /** Which procedure kind the access lives in — only `query`/`mutation` handlers are recorded. */
    kind: "mutation" | "query";
    /** 1-based line of the access. */
    line: number;
}

/**
 * One `ctx.kv.<method>(key, …)` call whose namespace key is derived from the
 * handler's `args` with no server-side scoping — the `kv_unscoped_user_key_idor`
 * lint input. Workers KV is a single flat namespace, so a key taken straight from
 * request input lets any caller read, overwrite, or delete another user's entry
 * (IDOR). Only arg-derived, unscoped keys reach here; a fixed literal, or a key
 * prefixed with a server-trusted identity (`${ctx.auth.userId}:…` — references
 * `ctx`, so treated as scoped), is not recorded. `list` is excluded (it takes a
 * prefix, not a per-entry key). Structurally identical to `AdvisorKvKeyAccess`.
 */
export interface KvKeyAccessIR {
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the `ctx.kv` call, or `0` when unknown. */
    line: number;
    /** The `ctx.kv` method invoked: `get` / `getRaw` / `getWithMetadata` / `put` / `delete`. */
    method: string;
    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;

    /**
     * Visibility of the enclosing procedure. `internal` procedures have no
     * untrusted caller by construction — see `owner_field_from_args_not_auth`'s
     * identical split — so `kv_unscoped_user_key_idor` drops the finding to
     * INFO rather than ERROR there. `undefined` when the access sits outside any
     * registered procedure the feeder could attribute it to.
     */
    visibility?: "internal" | "public";
}

/**
 * One `ctx.db` write (`insert` / `replace` / `patch` / `insertManyUnsafe`) that sets
 * an ownership / identity column — `userId`, `ownerId`, `tenantId`, and the like —
 * from the handler's `args` instead of the server-trusted identity. The
 * `owner_field_from_args_not_auth` lint input: the ownership column decides who a
 * row belongs to, so a value taken from request input lets any caller write rows
 * owned by another user or tenant (the act-as-any-user / cross-tenant IDOR vector).
 * A column stamped from `ctx.*`, or set to a fixed literal, is not recorded; only an
 * arg-derived identity write reaches here. Structurally identical to
 * `AdvisorOwnerFieldWrite`.
 */

/**
 * One branching `defineShape({ where })` / `definePolicy({ when })` predicate arm
 * that returns an unrestricted predicate — the `unrestricted_where_branch` lint
 * input. A denial arm must match NO rows (`deny()` / `{ OR: [] }`); `{}` matches
 * every row, so the near-miss silently replicates the whole table.
 */
export interface UnrestrictedWhereBranchIR {
    /** Export binding name of the shape / policy the predicate belongs to. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** Which unrestricted form was returned. */
    form: "empty-object" | "undefined";
    /** The config key carrying the predicate (`where` for a shape, `when` for a policy). */
    key: string;
    /** 1-based line of the offending returned expression. */
    line: number;
    /** The declaring call (`defineShape` / `definePolicy`). */
    owner: string;
}

export interface OwnerFieldWriteIR {
    /**
     * Every procedure that reaches the write carries `.use(platformAdmin(...))`
     * (see {@link FunctionIR.adminOnly}): the caller is a platform admin by design.
     */
    adminOnly?: true;
    /** The identity column being written from `args` (e.g. `userId`). */
    field: string;

    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;

    /**
     * The handler proves the value it writes equals the server identity before the
     * write: an `if (<args.field> !== <ctx identity>) throw` (also inside an `&&` or
     * `||` condition), or an `assert*(...)` call given both the argument and the
     * identity. The write is then validated, so `owner_field_from_args_not_auth`
     * declines to report it. Only facts that hold before the write count.
     */
    guarded?: true;

    /** 1-based line of the `ctx.db` write call, or `0` when unknown. */
    line: number;

    /** The `ctx.db` write method (`insert` / `replace` / `patch` / `insertManyUnsafe`). */
    method: string;

    /**
     * The enclosing `defineMutator` declared this very column as its `owner`, AND
     * the value written resolves, by symbol, to that same `args[owner]` of the
     * `server` impl's own 2nd parameter. A nested closure's or a helper's own
     * `args` (or any binding shadowing it) never qualifies.
     *
     * `applyOwnerScope` requires a verified identity, rejects a client-supplied
     * value that disagrees with it, and overwrites the column with the verified
     * one before `server` runs — so on this exact shape `args[owner]` IS the
     * server identity, and it is what the docs prescribe. Recorded rather than
     * dropped at discovery: the write did happen, and the feeder is otherwise the
     * only place that knows. `owner_field_from_args_not_auth` is what declines to
     * report it.
     *
     * Deliberately NOT set when only the column NAME matches: `owner: "userId"`
     * launders `args.userId` and nothing else, so `{ userId: args.targetUserId }`
     * is a real IDOR and stays reportable.
     */
    ownerScoped?: true;

    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;

    /**
     * Visibility of the enclosing procedure. `internal` procedures are not
     * reachable by a caller, so the lint's premise ("any caller can write rows
     * owned by another user") does not hold there — see
     * `owner_field_from_args_not_auth`. `undefined` when the write sits outside
     * any recognised procedure (a bare helper).
     */
    visibility?: "internal" | "public";
}

/**
 * One `ctx.storage.<bucket>.<method>(key, …)` call whose R2 object key is derived
 * from the handler's `args` with no server-side scoping — the
 * `storage_key_from_user_args` lint input. The bucket read/write/URL/delete methods
 * key by their first argument, so an object key taken straight from request input is
 * object-level IDOR (read/overwrite/delete anyone's object). A key referencing a
 * server-trusted `ctx.*` value (e.g. `${ctx.auth.userId}/…`) is treated as scoped
 * and is not recorded; only an arg-derived, `ctx`-free key reaches here.
 * Structurally identical to `AdvisorStorageKeyAccess`.
 */
export interface StorageKeyAccessIR {
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the storage call, or `0` when unknown. */
    line: number;
    /** The bucket method invoked with the arg-derived key, e.g. `get` / `put` / `delete` / `download`. */
    method: string;
    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;

    /**
     * Visibility of the enclosing procedure. `internal` procedures have no
     * untrusted caller by construction — see `owner_field_from_args_not_auth`'s
     * identical split — so `storage_key_from_user_args` drops the finding to
     * INFO rather than ERROR there. `undefined` when the access sits outside any
     * registered procedure the feeder could attribute it to.
     */
    visibility?: "internal" | "public";
}

/**
 * One `ctx.ai.run(model, …)` call whose model-id argument is derived from the handler's
 * `args` with no server-side scoping — the `ai_raw_run_escape_hatch` lint input.
 * `ctx.ai.run` is the raw Workers AI binding passthrough, bypassing the typed
 * `ctx.ai.model(...)` + AI-SDK layer (`generateText`/`streamText`/…) that caps output and
 * enforces a schema, so an arg-derived model id lets any caller select an arbitrary model.
 * A fixed literal model, or one scoped by a server-trusted `ctx.*` value, is not recorded;
 * only an arg-derived, unscoped model id reaches here (an arg-derived `inputs` argument is
 * normal usage and is never inspected). Structurally identical to `AdvisorAiRawRun`.
 */
export interface AiRawRunIR {
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the `ctx.ai.run` call, or `0` when unknown. */
    line: number;
    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;
}

/**
 * One `ctx.vectors.<method>(indexName, input)` call whose `input.namespace` is derived
 * from the handler's `args` with no server-side scoping — the
 * `vectors_namespace_from_user_input` lint input. A Vectorize namespace partitions one
 * index into isolated sub-collections, so a namespace taken straight from request input
 * lets any caller read or poison another tenant's vectors. A fixed literal namespace, or
 * one prefixed with a server-trusted identity (`${ctx.auth.orgId}` — references `ctx`, so
 * treated as scoped), is not recorded; only an arg-derived, unscoped namespace reaches
 * here. Structurally identical to `AdvisorVectorNamespaceAccess`.
 */
export interface VectorNamespaceAccessIR {
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the `ctx.vectors` call, or `0` when unknown. */
    line: number;
    /** The `ctx.vectors` method invoked: `query` / `upsert` / `upsertNow`. */
    method: string;
    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;
}

/**
 * One `ctx.mail`/`ctx.email` `send`/`queue` call whose recipient field (`to`/`cc`/`bcc`)
 * is derived from the handler's `args` with no server-side scoping — the
 * `mail_recipient_from_request_input` lint input. A recipient taken straight from request
 * input turns the deployment into an open relay / spam amplifier (any caller can direct
 * mail to an arbitrary address). A fixed literal recipient, or one scoped by a
 * server-trusted `ctx.*` value (e.g. `ctx.auth.user.email`), is not recorded; only an
 * arg-derived, unscoped recipient reaches here. Structurally identical to
 * `AdvisorMailRecipientAccess`.
 */
export interface MailRecipientAccessIR {
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the `ctx.mail`/`ctx.email` call, or `0` when unknown. */
    line: number;
    /** The mailer method invoked: `send` / `queue`. */
    method: string;
    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;
}

/**
 * One `ctx.browser.<method>(url, …)` call whose navigation URL (`arguments[0]`)
 * is derived from the handler's `args` with no server-side scoping — the
 * `browser_user_url_without_allowlist` lint input. The lint additionally
 * cross-references `createBrowser` config-call evidence to suppress findings
 * when the browser is hardened with an `allowedHosts` allowlist or
 * `resolveDns`. Structurally identical to `AdvisorBrowserUrlAccess`.
 */
export interface BrowserUrlAccessIR {
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the `ctx.browser` call, or `0` when unknown. */
    line: number;
    /** The browser method invoked: `content` / `pdf` / `scrape` / `screenshot`. */
    method: string;
    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;
}

/**
 * One payload-derived privileged dispatch — a `ctx.run`/`context.run` back into a
 * Lunora function from inside a `defineQueue` push handler or a `defineWorkflow`
 * handler, whose args reference the handler's untrusted payload (`context.params`
 * for a workflow, a `for (… of batch.messages)` body for a queue) — the
 * `privileged_dispatch_unvalidated_payload` lint input. Both handler kinds run
 * under the **system identity** (RLS disabled), so forwarding attacker-influenced
 * payload into the dispatch bypasses the target's row policy. The resolved
 * `targetFile`/`targetExport` let the lint join RLS-procedure evidence and fire
 * only for RLS-gated targets. Structurally identical to `AdvisorPrivilegedDispatch`.
 */
export interface PrivilegedDispatchIR {
    /** `"queue"` for a `defineQueue` handler, `"workflow"` for a `defineWorkflow` handler. */
    dispatchKind: "queue" | "workflow";
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the dispatch call, or `0` when unknown. */
    line: number;
    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;
    /** Export name of the dispatched target (`send` in `api.messages.send`). */
    targetExport: string;
    /** File path of the dispatched target relative to `lunora/` (`messages` in `api.messages.send`). */
    targetFile: string;
}

/**
 * One tracked `ctx.storage.<bucket>.<method>(...)` upload/signing call — the
 * shared input for the storage config-hygiene security lints
 * (`storage_upload_without_content_type_allowlist`, `storage_upload_without_max_size`,
 * `storage_generate_upload_url_no_content_type_pin`, `storage_presigned_url_for_private_content`).
 * `upload`/`store` carry the `UploadOptions` guards (`allowedContentTypes` /
 * `maxSize`); `generateUploadUrl` carries the signed-PUT `contentType` pin;
 * `getPresignedUrl`/`getSignedUrl` carry a statically-known `expiresInSeconds`
 * literal. `presentKeys` is empty (and `expiresInSeconds` unset) when the
 * options argument was absent, a non-literal, or a spread — see `analyzable`.
 * Structurally identical to `AdvisorStorageUpload`.
 */
export interface StorageUploadIR {
    /** `true` when the call's options-object argument (or its deliberate absence) was statically resolvable. */
    analyzable: boolean;
    /** Numeric literal value of an `expiresInSeconds` option, when statically known (`getSignedUrl` / `getPresignedUrl` only). */
    expiresInSeconds?: number;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the call, or `0` when unknown. */
    line: number;
    /** The `ctx.storage` method invoked. */
    method: "generateUploadUrl" | "getPresignedUrl" | "getSignedUrl" | "store" | "upload";
    /** Options-object keys present at the call site (empty when not `analyzable`, or when no options argument was passed). */
    presentKeys: string[];
    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;
}

/**
 * One discovered `httpAction`/`httpRoute` handler in `lunora/` that performs a
 * side effect (`ctx.runMutation` / `ctx.runAction` / a `ctx.db.{insert,patch,
 * replace,delete,insertManyUnsafe}` write) from the HTTP edge, with whether it
 * reads `ctx.auth` — the `http_action_missing_auth_guard` lint input. A handler
 * that mutates state or dispatches an action without ever consulting the request
 * identity is an unauthenticated write bypassing identity/RLS. Only handlers with
 * a statically-resolvable inline body and `ctx` binding are recorded (fail-safe
 * under-report); read-only handlers are never recorded. Structurally identical to
 * `AdvisorHttpActionGuard`.
 */
export interface HttpActionGuardIR {
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** Which HTTP surface the handler is: a raw `httpAction` or a typed `httpRoute` route. */
    kind: "httpAction" | "httpRoute";
    /** 1-based line of the handler call, or `0` when unknown. */
    line: number;
    /** For an `httpRoute`, the uppercased verb (`"POST"`); absent for a raw `httpAction`. */
    method?: string;
    /** `true` when the handler reads `ctx.auth` (a direct member access or a `const { auth } = ctx` destructure). */
    readsAuth: boolean;
    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;
    /** The first side effect found, as a stable label: `runMutation`, `runAction`, or `db.<method>`. */
    sideEffect: string;
}

/**
 * One response-header write, inside an `httpAction` handler, whose value is derived
 * from raw request input (`request.headers`, `request.url`/query, `await
 * request.json()`) with no CR/LF sanitizer — the
 * `http_action_response_header_injection` lint input. A `Request`-derived string
 * placed verbatim into a response header lets a caller smuggle `\r\n` and inject
 * extra headers or split the response (header injection / response splitting). Only
 * sites whose value is request-tainted AND unguarded are recorded: a value routed
 * through a CR/LF guard (`isSafeHeaderValue`), a URL/URI encoder
 * (`encodeURIComponent`/`encodeURI`), a numeric coercion (`Number`/`parseInt`/
 * `parseFloat`), or `btoa` is treated as safe and never recorded (`String(...)` /
 * `.toString()` are NOT sanitizers — they don't strip CR/LF). Structurally
 * identical to `AdvisorHttpHeaderWrite`.
 */
export interface HttpHeaderWriteIR {
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** The header name being written (`"location"`), or `""` when the key is not a string literal. */
    headerName: string;
    /** 1-based line of the request-tainted header value. */
    line: number;
    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;
    /** How the header was written. */
    via: "headers-append" | "headers-ctor" | "headers-set" | "response-init";
}

/**
 * One rate-limit / Turnstile middleware call in `lunora/` — the
 * `ratelimit_middleware_fail_open` lint input. `rateLimit`/`dbRateLimit`
 * (`@lunora/ratelimit`) and `verifyTurnstileMiddleware` (`@lunora/auth`) each
 * accept a `failOpen` escape hatch that admits every request when the
 * limiter/siteverify is unavailable; `failOpen` is `true` only when the options
 * literal set it to the boolean literal `true` (anything else is fail-closed).
 * The lint escalates a fail-open guard to a finding when the guarded procedure
 * (`exportName`/`limitName`) looks auth/payment-sensitive. Structurally
 * identical to `AdvisorFailOpenGuard`.
 */
export interface FailOpenGuardIR {
    /** The middleware factory at the call site: `rateLimit` / `dbRateLimit` / `verifyTurnstileMiddleware`. */
    callee: string;
    /** `true` only when the options literal set `failOpen: true` as a boolean literal; a non-literal or absent option is treated as fail-closed. */
    failOpen: boolean;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** The rate-limit `name` (second string argument) for `rateLimit`/`dbRateLimit`; `""` for `verifyTurnstileMiddleware`. */
    limitName: string;
    /** 1-based line of the middleware call, or `0` when unknown. */
    line: number;
    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;
}

/**
 * One `ctx.flags.boolean("key", <boolean-literal>)` read in `lunora/` — the
 * `flag_gates_security_with_unsafe_default` lint input. OpenFeature returns the
 * `defaultValue` when the provider errors, so a fail-open default on a
 * security-shaped key silently opens access during an outage. Only reads with a
 * statically-known string key and boolean-literal default are recorded; the lint
 * owns the security-shape + polarity judgment. Structurally identical to
 * AdvisorFlagSecurityDefault.
 */
export interface FlagSecurityDefaultIR {
    /** The boolean-literal default returned on a provider outage (fail-open value). */
    defaultValue: boolean;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** The flag key — the first string-literal argument of `ctx.flags.boolean`. */
    key: string;
    /** 1-based line of the `ctx.flags.boolean` call, or `0` when unknown. */
    line: number;
    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;
}

/**
 * One `ctx.flags` read lexically inside a `query(...)` handler — the
 * flag_read_in_subscription advisor lint input. Flag changes append nothing to
 * `__cdc_log`, so a subscribed query is never re-run when a flag flips and keeps
 * serving the branch it last picked; `useFlag` is the reactive path. Structurally
 * identical to the advisor's `AdvisorFlagRead` (same field set) so values pass
 * straight through `lintSchema` without conversion, exactly as `ContextPropertyCallIR` does.
 *
 * Only `query` handlers are recorded — unlike `ContextPropertyCallIR` / `NondeterministicCallIR`
 * there is no `kind` field, because `mutation`/`action` handlers run once and have
 * no subscription staleness to warn about, so the feeder drops them rather than
 * handing the lint rows it would discard.
 */
export interface FlagReadIR {
    /** The accessed `ctx.flags` surface, e.g. `ctx.flags.boolean` / `ctx.flags.details.string`. */
    callee: string;
    /** Export binding name of the query performing the read. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension (the api namespace). */
    file: string;
    /** 1-based line of the read, or `0` when unknown. */
    line: number;
}

/**
 * One `generateText` / `streamText` call in `lunora/` whose `tools` reach a
 * privileged side effect (a DB write, function dispatch, or outbound
 * fetch/mail/queue send). `userInputDerived` records whether the model input
 * (`prompt`/`messages`/`system`) flows from the handler's `args`; the
 * `ai_tool_side_effect_prompt_injection` lint fires only when it does.
 * Structurally identical to `AdvisorAiToolSideEffect`.
 */
export interface AiToolSideEffectIR {
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the generation call, or `0` when unknown. */
    line: number;
    /** The generation entrypoint invoked. */
    method: "generateText" | "streamText";
    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;
    /** The privileged side-effect sink a model-callable tool reaches (`ctx.db.insert`, `ctx.run`, `ctx.fetch`, …). */
    sideEffect: string;
    /** `true` when a model-input option is derived from the handler's `args` (a bare `args.x`, or a name destructured from `args`). */
    userInputDerived: boolean;
}

/**
 * One `<receiver>.identity.<key>` claim read in `lunora/`, where `<receiver>` is
 * an RLS/mask policy `auth` (or `ctx.auth`/`context.auth`). `declared` records
 * whether `<key>` is in the app's `defineIdentity({ ... })` contract (or the
 * always-present `userId`); the `identity_undeclared_claim_trusted` lint fires on
 * the undeclared reads. Emitted only when a resolvable identity contract exists.
 * Structurally identical to `AdvisorIdentityClaimRead`.
 */
export interface IdentityClaimReadIR {
    /** `true` when `key` is a declared claim (in the `defineIdentity` contract, or the always-present `userId`). */
    declared: boolean;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** The claim key read off the identity bag. */
    key: string;
    /** 1-based line of the read, or `0` when unknown. */
    line: number;
    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;
}

/**
 * One payment webhook-adapter construction in `lunora/` (`createStripeAdapter` /
 * `createPolarAdapter` / `createAutumnAdapter` / `createDodoPaymentsAdapter`).
 * `toleranceSeconds` carries the statically-known `webhookToleranceSeconds`
 * replay window when it is a plain numeric literal; the payment-webhook
 * wide-tolerance lint fires when it exceeds a conservative ceiling. Structurally
 * identical to `AdvisorPaymentWebhook`.
 */
export interface PaymentWebhookIR {
    /** The adapter factory invoked. */
    callee: "createAutumnAdapter" | "createDodoPaymentsAdapter" | "createPolarAdapter" | "createStripeAdapter";
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the construction, or `0` when unknown. */
    line: number;
    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;
    /** Statically-known `webhookToleranceSeconds` literal, when present and a plain numeric literal. */
    toleranceSeconds?: number;
}

/**
 * One `query`/`mutation` handler that gates a `ctx.db.get`/`patch`/`delete` on a
 * null-checked `ctx.db.normalizeId(table, id)` result — the
 * `normalize_id_used_as_authorization` lint input. `normalizeId` validates an id's
 * structural shape only (it never reads the database), so a non-null result proves
 * the id is well-formed, never that the caller owns the row; gating access on it is
 * an IDOR. The lint owns the negative proof — it keeps only `visibility === "public"`
 * rows with no `.use(rls(...))` and no ownership/identity mention (`mentionsOwnership`),
 * then joins `table` against the schema's RLS mode before flagging. Structurally
 * identical to AdvisorNormalizeIdAuthorization so values pass straight through.
 */
export interface NormalizeIdAuthorizationIR {
    /** Export binding name of the procedure performing the normalize-then-access. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the `ctx.db.normalizeId(...)` call the access is gated on. */
    line: number;
    /** `true` when the handler anywhere reads an ownership-named identifier or `ctx.auth`/`ctx.identity`/… — an intervening ownership signal. */
    mentionsOwnership: boolean;
    /** The id-first `ctx.db` sink the normalized id reaches. */
    sinkMethod: "delete" | "get" | "patch";
    /** Table named in the `normalizeId` call, or `""` when its table argument wasn't a string literal. */
    table: string;
    /** `true` when the procedure's builder chain carries a `.use(rls(...))` step. */
    usesRls: boolean;
    /** `"internal"` for `internalQuery`/`internalMutation`; `"public"` for `query`/`mutation`. */
    visibility: "internal" | "public";
}
