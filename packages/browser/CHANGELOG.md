## @lunora/browser [1.0.0-alpha.95](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.94...@lunora/browser@1.0.0-alpha.95) (2026-11-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.85

## @lunora/browser [1.0.0-alpha.94](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.93...@lunora/browser@1.0.0-alpha.94) (2026-11-02)

### ⚠ BREAKING CHANGES

* `createBrowser`'s `launch`, `connect` and `sessions` options are removed;
pass `playwright: () => import("@cloudflare/playwright")` instead. `PlaywrightModuleLike` is
the loaded module's type.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* perf(payment): load provider SDKs on first use

Every provider adapter took a constructed client, so an app built it at the top of its Worker
entry (`import Stripe from "stripe"`). That put the SDK in the startup graph of every isolate,
eager and lazy builds alike: `stripe` alone is 197 modules / ~1 MiB.

`client` is now a loader, `() => Client | Promise<Client>`, awaited by the first provider call
and reused for the adapter's life (`shared/lazy-value.ts`), so the app `import()`s the SDK
inside it. `identifier` and `capabilities` stay static: the facade reads them synchronously.
A rejected load reaches that call unchanged and the next call retries. Applies to all five
adapters (Stripe, Polar, Autumn, Creem, Dodo Payments); `createAutumnFeatures` is unchanged.
* `create{Stripe,Polar,Autumn,Creem,DodoPayments}Adapter({ client })` takes a
loader, e.g. `client: async () => new (await import("stripe")).default(key, opts)`, not a
client instance.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* perf(hyperdrive): build the SQL driver on the first query

`fromPostgresJs` / `fromNodePg` / `fromMysql2` wrapped a driver instance, so the `.hyperdrive()`
thunk had to `import postgres from "postgres"` at the top of the Worker entry and every isolate
evaluated the driver at startup.

They now take a loader returning the driver, run on the first query and reused
(`shared/lazy-value.ts`); the app `import()`s the driver inside it, and a `pg` loader can
`await client.connect()` first. A rejected load fails that query unchanged and the next one
retries. `buildPgExec(fromPostgresJs(...))` for `.hyperdriveGlobal` takes the same form.
`buildMysqlExec` still takes the raw mysql2 connection: it checks the connection's flags
synchronously.
* `fromPostgresJs`, `fromNodePg` and `fromMysql2` take a loader
(`() => driver | Promise<driver>`), not a driver.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* perf(mcp): load the MCP SDK per request in the HTTP handlers

`createMcpFetchHandler` and `createAuthedMcpFetchHandler` imported `createLunoraMcpServer`, and
`serveStateless` the Streamable-HTTP transport, at module scope. A Worker that mounted an MCP
endpoint from `@lunora/mcp/worker` therefore evaluated `@modelcontextprotocol/sdk` (203
modules / ~1 MiB with its validators) at startup.

The handlers now `import()` the server module per request and `serveStateless` loads the
transport per call; the module cache makes every load after the first free. Option validation
and the admin client move to `server-options.ts`, which does not touch the SDK, so a
misconfigured handler still throws when it is built. All of this runs on the Worker, not in a
Durable Object.

`createToolServer`, `createPaidMcpServer` and `createFunctionMcpServer` still build a `Server`
synchronously and keep the SDK eager for apps that use them.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(codegen): point the browser and sql diagnostics at the loaders

The `.browser()` doc and the `ctx.browser` / `ctx.sql` missing-thunk messages, the
`.hyperdriveGlobal()` builder doc and its `wrangler-project` diagnostic named the removed
`createBrowser({ launch })` option and a driver built at module scope. They now show the loader
forms (`playwright: () => import("@cloudflare/playwright")`,
`fromPostgresJs(async () => (await import("postgres")).default(...))`), so the fix a diagnostic
suggests compiles and keeps the SDK out of the startup graph.

The codegen API snapshot also picks up `lazyFunctions` and the `lazy` option of `emitAgents` /
`emitWorkflows`, which the phase-2 commits on this branch added without re-snapshotting.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* test(startup): keep integration SDKs out of the startup graph

The startup gate's fixture now also wires `.browser()`, `.payment()` with Stripe,
`.hyperdrive()` with postgres.js and an `@lunora/mcp/worker` handler, each through its
documented loader. The gate also fails, in eager and lazy runs alike, when any of
`@cloudflare/playwright`, `stripe`, `postgres` or `@modelcontextprotocol/sdk` is statically
reachable from the entry, and prints the import chain that reached it.

That check follows only modules that put bytes in the bundle, plus pure re-export barrels.
The metafile keeps a barrel's edge to a module esbuild dropped: `@lunora/mcp/worker`
re-exports `createToolServer`, whose `Server` import is never evaluated by an app that mounts
only `createMcpFetchHandler`. The module/byte count is unchanged in method, so it still
includes those dropped modules (~198 MCP modules).

Same fixture, local `build:prod` (static graph, modules / KiB):

  eager build: static SDK imports 1,709 / 11,456 -> loaders 1,223 / 7,213
  lazy build:  static SDK imports 1,299 /  9,100 -> loaders   808 / 4,801

The lazy "before" ran on the old package builds; the eager "before" ran the old wiring against
the new builds, so its MCP share is about 5 modules low. Lazy-build attribution before:
`@cloudflare/playwright` 278 / 3,167, `stripe` 197 / 999, MCP SDK via `@lunora/mcp`
203 / 992, `postgres` 11 / 76. The old wiring, or reverting the `createMcpFetchHandler`
deferral, fails the gate. Baseline moves from 995 / 6,104 KiB (fixture without integrations)
to 1,223 / 7,213 KiB (`worker-startup.json`). Plan 490 records phase 3, the input-gate
reasoning (incl. `.hyperdriveGlobal` on mutation paths) and what stays eager.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* refactor(payment): restore adapter notes and check the secret first

Put back the merchant-of-record notes on cancelPayment that the loader change dropped, check
the Stripe webhook secret before loading the client as the eager version did, and rewrap the
doc comments the loader edits left overlong.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* perf(mcp): build every MCP server with the SDK loaded on first use

`createToolServer`, `createFunctionMcpServer` and `createPaidMcpServer` imported
`@modelcontextprotocol/sdk` at module scope, and `@lunora/mcp/worker` re-exports them, so a Worker
using any of them evaluated the SDK (~200 modules / ~1 MiB) at startup.

The builders now load `Server` and the request schemas through one `import()` (`src/sdk.ts`):
`createToolServer`, `createFunctionMcpServer`, `createDocsMcpServer` and `createLocalMcpServer`
are async. `createPaidMcpServer` keeps its synchronous API, since apps create it and register
tools at module scope: registration no longer compiles the input schema, the first request
compiles it (the validator is part of the SDK) and builds the server. The function server still
checks the OpenRPC document before it loads the SDK. A new test fails if the worker entry
statically imports the SDK again.
* `createToolServer`, `createFunctionMcpServer`, `createDocsMcpServer` and
`createLocalMcpServer` return `Promise<Server>`; await them. A malformed OpenRPC document now
rejects the `createFunctionMcpServer` promise instead of throwing.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* perf(hyperdrive): load mysql2 for .hyperdriveGlobal on the first statement

`buildMysqlExec` took a built `mysql2/promise` connection because it checked the connection's
`CLIENT_FOUND_ROWS` flag synchronously, so a MySQL `.hyperdriveGlobal` app imported `mysql2` at the
top of its entry and every isolate evaluated it at startup.

`buildMysqlExec` and `createMysqlGlobalCtxDb` now take a loader, like `fromMysql2`. It runs on the
first statement and is reused; the flag check runs when it resolves, before any statement. A
connection without the flag fails that statement and is not kept, so every later statement fails
the same way rather than running unguarded. Nothing is loaded when the exec is built: the shard
builds it with the ctx, possibly before the mutation's input-gated span, and the import has to start
inside that span, as with `buildPgExec(fromPostgresJs(load))`.
* `buildMysqlExec` and `createMysqlGlobalCtxDb` take a loader
(`() => connection | Promise<connection>`), not a connection, and report a missing
`CLIENT_FOUND_ROWS` flag by failing the first statement instead of throwing at construction.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* perf(payment): take the Autumn features client as a loader

`createAutumnFeatures` only imports `autumn-js` as a type, but it took a built client, so an app
that created the facade at module scope had to construct the `Autumn` client there and evaluated
the SDK at startup; the docs told apps to build it inside each handler instead.

It now takes the same loader as `createAutumnAdapter`, run on the first call and reused, with a
failed load retried on the next call. One loader can feed both.
* `createAutumnFeatures({ client })` takes a loader
(`() => client | Promise<client>`), not a client.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* feat(cli): smoke-load the integration SDKs an app loads with import()

The integration loaders (`playwright: () => import("@cloudflare/playwright")`, a payment `client`
or Hyperdrive driver that imports `stripe`, `postgres` or `mysql2/promise` inside it) move an SDK's
module evaluation to its first use, in eager builds too. An SDK that throws while evaluating in
workerd would fail its first request instead of the deploy, and the smoke check could not see it:
the loaders are app-supplied closures that generated code never names.

`collectIntegrationModules` walks the Worker's own files (the entry, what it imports, and the
schema directory without `_generated`) and returns the package specifiers of their literal
`import()` calls that are installed in the project. The smoke entry gives each one a literal
`import()` and reports the ones that fail, next to the lazy function modules. The check now runs
when either exists, so an eager app with integration loaders is checked before `build`, `deploy`
and `prepare`; an eager app without them still is not.

Not covered: an SDK a package loads for itself (the MCP SDK inside `@lunora/mcp`), and projects
the check already skips (containers, a Hyperdrive binding with no local database).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* test(startup): cover every MCP server builder and mysql2 in the gate

The reference app now also wires `.hyperdriveGlobal` on MySQL (a table with
`.global({ backend: "hyperdrive" })`, `buildMysqlExec` with a `mysql2/promise` loader) and every
`@lunora/mcp/worker` server: `createToolServer` and `createFunctionMcpServer` awaited in `fetch`,
and a `createPaidMcpServer` given a tool at module scope. `mysql2` joins the forbidden SDKs. The
fixture has to call each builder, since esbuild drops one it never calls and a static SDK import
in it would go unseen.

Restoring the synchronous `createToolServer` (1,377 modules) or `createPaidMcpServer` (1,387), or a
static `mysql2` import in the entry, fails the gate. The baseline moves to 1,239 modules /
7,080 KiB (from 1,223 / 7,213): the `.hyperdriveGlobal` store adds modules, and the
`@lunora/mcp/worker` barrel no longer carries static SDK edges.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* docs(plans): record the remaining integration deferrals in plan 490

The MCP server builders, `.hyperdriveGlobal` on MySQL and `createAutumnFeatures` now load their SDK
on first use, the smoke-load evaluates the packages an app loads with `import()`, and the gate
fixture covers them. §3.2 replaces its "remaining eager" list with that, the new gate numbers, and
the input-gate reasoning for `buildMysqlExec`.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(mcp): compile a paid tool's schema on its own first call

Deferring the schema compiler to the first request compiled every registered tool's `inputSchema`
there, so one schema the validator could not compile failed every request, `tools/list`
included, where it used to throw at `tool()`. Each tool's schema now compiles on that tool's first
call and is kept per tool, so a bad schema fails only its own calls.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(cli): smoke-load only the import()s of files the Worker loads

The integration-module scan took every source file under the schema directory as a root, so a
colocated test or a seed script's Node-only `import()` would be evaluated in workerd and could
block a deploy. It now walks from the entry along relative imports only, passing through
`_generated` (which is how the entry reaches the function modules) without collecting from it.

Checked against a real `wrangler dev`: `lunora prepare` on examples/payment-demo evaluates
`stripe` cleanly, and blocks naming `import("boom")` for a package that throws at evaluation.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* style(hyperdrive): reflow the buildMysqlExec doc comment

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(cli): smoke-load a vite-built worker and name a hung step

On a project built by the Cloudflare Vite plugin (the saas template) the smoke check hung for
120s and blamed a module that never settles. Nothing was evaluated: the build leaves
.wrangler/deploy/config.json, which sends `wrangler dev` to the built, no_bundle
dist/server/wrangler.json, where the TypeScript smoke entry does not parse; with the source config
* global writes over a postgres.js client without
`begin()` or a single mysql2 connection are refused instead of being
written non-atomically. Pass a mysql2 pool or a client with `begin()`.
The upgrade guide and the hyperdrive docs record the change.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>

* test(hyperdrive): run the MySQL integration suite on a pool

The harness handed one mysql2 connection to the global exec, which the
transaction guard now refuses. It builds the exec from a pool, so the
atomic path (including the lease CAS and the uncommitted-seq read) runs
over real transactions, and a new test shows a single connection is
refused with GLOBAL_TRANSACTION_UNSUPPORTED. Also records the new error
code in the errors API snapshot.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>

* fix(cli): resolve every * in an import target, escape spliced literals

- A subpath import target substitutes every `*`, as Node does, not only
  the first.
- The smoke Worker entry quotes specifiers and paths through the shared
  literal helper, which also escapes `<`, `>`, `/`, U+2028 and U+2029.
- The startup gate checks a barrel one statement at a time. The single
  anchored regex backtracked exponentially: 3.4 s at 14 repeated
  `export*` tokens, 66 s at 18. The sticky matcher gives the same answers
  in under a millisecond.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(cli): scan SDK loaders the way the bundler resolves them

The integration-module walk picked a different file than the Worker loads in several cases, so an
SDK loader could go unchecked, or an unused one could block a deploy.

- a subpath import whose captured text held `$&` or `$$` was expanded by replaceAll; a replacer
  function inserts it as written
- an exact `imports` key now wins over a pattern declared before it, as in Node
- a `types` condition is skipped when choosing the runtime target of an `imports` entry
- `import { type X }` and `export { type X } from` are erased unless verbatimModuleSyntax is set
- the smoke entry stubs the classes of the config deploy runs against, not the default config
- class names with Unicode letters are accepted as identifiers
- the functions answer must carry this run's id, like every other step
- integration failures are capped at ten in the error, with a count of the rest

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>

* fix(mcp): return a schema the validator cannot run as a tool error

A paid server compiled and ran a tool's inputSchema outside the try that turns failures into
isError results, so a schema the validator rejects surfaced as a JSON-RPC protocol error. It is now
answered as a tool result like any other handler failure.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>

* fix(payment): reject a Dodo partial refund before loading the client

refundPayment awaited the client loader before rejecting an amount-based refund, so a failing or
hanging loader masked the unsupported-partial-refund error. The check now runs first.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>

* docs(hyperdrive): say a global write without a transaction fails

The skill and two doc comments still said a single mysql2 connection, or a postgres.js client
without begin(), commits companions one statement at a time. Those writes now reject with
GLOBAL_TRANSACTION_UNSUPPORTED before writing anything.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>

* fix(scripts): do not link an SDK the startup fixture already has

The fixture linked each integration SDK after the host's @cloudflare packages, so a host that
carries @cloudflare/playwright made the second symlink throw EEXIST before the check ran.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>

* docs(errors): regenerate the error reference for the new catalog code

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>

### Performance Improvements

* load integration SDKs on first use instead of at worker startup ([#1423](https://github.com/anolilab/lunora/issues/1423)) ([d3bd332](https://github.com/anolilab/lunora/commit/d3bd3321039db1e8f51f26ad0a35ca72f71d885c)), closes [#tanstack-router-entry](https://github.com/anolilab/lunora/issues/tanstack-router-entry) [#-imports](https://github.com/anolilab/lunora/issues/-imports)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.84

## @lunora/browser [1.0.0-alpha.93](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.92...@lunora/browser@1.0.0-alpha.93) (2026-11-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.83

## @lunora/browser [1.0.0-alpha.92](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.91...@lunora/browser@1.0.0-alpha.92) (2026-11-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.82

## @lunora/browser [1.0.0-alpha.91](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.90...@lunora/browser@1.0.0-alpha.91) (2026-10-31)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.81

## @lunora/browser [1.0.0-alpha.90](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.89...@lunora/browser@1.0.0-alpha.90) (2026-10-31)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.80

## @lunora/browser [1.0.0-alpha.89](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.88...@lunora/browser@1.0.0-alpha.89) (2026-10-30)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.79

## @lunora/browser [1.0.0-alpha.88](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.87...@lunora/browser@1.0.0-alpha.88) (2026-10-30)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.78

## @lunora/browser [1.0.0-alpha.86](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.85...@lunora/browser@1.0.0-alpha.86) (2026-10-29)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.76

## @lunora/browser [1.0.0-alpha.85](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.84...@lunora/browser@1.0.0-alpha.85) (2026-10-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.75

## @lunora/browser [1.0.0-alpha.84](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.83...@lunora/browser@1.0.0-alpha.84) (2026-10-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.74

## @lunora/browser [1.0.0-alpha.83](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.82...@lunora/browser@1.0.0-alpha.83) (2026-10-27)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.73

## @lunora/browser [1.0.0-alpha.82](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.81...@lunora/browser@1.0.0-alpha.82) (2026-10-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.72

## @lunora/browser [1.0.0-alpha.81](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.80...@lunora/browser@1.0.0-alpha.81) (2026-10-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.71

## @lunora/browser [1.0.0-alpha.80](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.79...@lunora/browser@1.0.0-alpha.80) (2026-10-25)

### Bug Fixes

* bug, security and perf fixes from the 2026-10-19 audit ([#1272](https://github.com/anolilab/lunora/issues/1272)) ([7f9d455](https://github.com/anolilab/lunora/commit/7f9d455405fc23686ee253a404b7e231dc5bb702))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.70

## @lunora/browser [1.0.0-alpha.79](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.78...@lunora/browser@1.0.0-alpha.79) (2026-10-24)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.69

## @lunora/browser [1.0.0-alpha.78](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.77...@lunora/browser@1.0.0-alpha.78) (2026-10-20)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.68

## @lunora/browser [1.0.0-alpha.77](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.76...@lunora/browser@1.0.0-alpha.77) (2026-10-20)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.67

## @lunora/browser [1.0.0-alpha.76](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.75...@lunora/browser@1.0.0-alpha.76) (2026-10-20)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.66

## @lunora/browser [1.0.0-alpha.75](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.74...@lunora/browser@1.0.0-alpha.75) (2026-10-19)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.65

## @lunora/browser [1.0.0-alpha.74](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.73...@lunora/browser@1.0.0-alpha.74) (2026-10-19)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.64

## @lunora/browser [1.0.0-alpha.73](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.72...@lunora/browser@1.0.0-alpha.73) (2026-10-19)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.63

## @lunora/browser [1.0.0-alpha.72](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.71...@lunora/browser@1.0.0-alpha.72) (2026-10-18)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.62

## @lunora/browser [1.0.0-alpha.71](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.70...@lunora/browser@1.0.0-alpha.71) (2026-10-18)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.61

## @lunora/browser [1.0.0-alpha.70](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.69...@lunora/browser@1.0.0-alpha.70) (2026-10-18)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.60

## @lunora/browser [1.0.0-alpha.69](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.68...@lunora/browser@1.0.0-alpha.69) (2026-10-18)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.59

## @lunora/browser [1.0.0-alpha.68](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.67...@lunora/browser@1.0.0-alpha.68) (2026-10-17)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.58

## @lunora/browser [1.0.0-alpha.67](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.66...@lunora/browser@1.0.0-alpha.67) (2026-10-16)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.57

## @lunora/browser [1.0.0-alpha.66](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.65...@lunora/browser@1.0.0-alpha.66) (2026-10-15)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.56

## @lunora/browser [1.0.0-alpha.65](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.64...@lunora/browser@1.0.0-alpha.65) (2026-10-15)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.55

## @lunora/browser [1.0.0-alpha.64](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.63...@lunora/browser@1.0.0-alpha.64) (2026-10-14)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.54

## @lunora/browser [1.0.0-alpha.63](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.62...@lunora/browser@1.0.0-alpha.63) (2026-10-12)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.53

## @lunora/browser [1.0.0-alpha.62](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.61...@lunora/browser@1.0.0-alpha.62) (2026-10-08)

### Bug Fixes

* **notify:** errors range, per-message urgency, channel secrets, SW hang ([#1043](https://github.com/anolilab/lunora/issues/1043)) ([f0e6b1c](https://github.com/anolilab/lunora/commit/f0e6b1cea73d9f5f05b793a1ebf79306e159c148))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.52

## @lunora/browser [1.0.0-alpha.61](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.60...@lunora/browser@1.0.0-alpha.61) (2026-10-07)

### ⚠ BREAKING CHANGES

* **x402:** @lunora/x402/pay no longer exports createPayFetch,
registerWallet, resolveEvmAccount, resolveSvmSigner, buildSpendPolicy,
buildPaymentGuard, releaseSpendOnFailure, assertBoundedPolicy,
createSpendState, SpendState or WalletDeps; @lunora/x402/charge no longer
exports createFacilitatorClient or toReceipt. Use createX402Pay / lazyX402Pay
and createChargeMiddleware. SpendPolicy.decimals (already throwing) is removed.
X402PayDeps declares getSecret itself. Network and recipient misconfiguration
throws LunoraError ENV_INVALID instead of Error.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* feat(browser): verify on workerd and settle the surface

Add a LUNORA_WORKERD_TESTS-gated workerd project for plan 463 (B3). It runs
createBrowser with the real @cloudflare/playwright launch / connect / sessions
against a fake Browser Run behind a real service binding (an entrypoint of the
test worker). It asserts what reaches the binding: keep_alive in milliseconds,
allowedHosts as normalized guardrails, the session id on connect, the session
list, and quickAction arguments across the RPC boundary. It also covers the
operation deadline, the DoH re-check and its timeout, and /crawl errors on
workerd's timers and fetch. The fake refuses the DevTools upgrade, since no
Chrome runs locally, so a live page stays covered only by the Node doubles.

Keep all 25 exports, drop their @experimental tags, and export the four types
the surface already referenced (BrowserSession, BrowserConnectLike,
BrowserSessionsLike, RouteLike). Node tests cover a failing close(). Docs gain a
platform-support table and the error reference. The workerd CI matrices gain
browser (15 packages).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* chore(api): graduate x402 and browser to stable adapter

Move both from TIER_3 to TIER_2 (plan 463, B3), which puts their snapshots in
FULLY_TRACKED_SNAPSHOTS: every export signature is now gated by api:check.
Regenerate both snapshots, and update the ROADMAP tier lists and table, the
versioning page, the package index and plan 463.

Bar item 5 (used in anger outside this repo) is not something this change can
show; it is left to maintainer sign-off.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* fix(notify): refuse a host whose DoH answer has no address

shared/ssrf-resolve classified a DoH answer with no A/AAAA record (an empty
answer, SERVFAIL, NXDOMAIN) as "public". A name's nameserver can fail the check
and answer the connecting resolver a moment later, so that passed a rebinding
attack. It is now a separate "unresolved" verdict, which callers refuse; a
lookup that could not complete at all still falls back to the string guard.

@lunora/notify refuses an unresolved web-push host at send time and does not
cache the verdict, since a SERVFAIL can be transient. A broadcast test that had
been resolving push.example over the real network now stubs DoH.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* fix(browser): check redirect hops and guard every handed-out browser

Playwright calls a route handler only for the first request of a redirect
chain, so the page.route guard never saw a 3xx hop: a public URL could 302 the
browser to 10.0.0.5 or the metadata endpoint unchecked. The guard now sits on
the context, fetches each navigation itself with route.fetch({ maxRedirects: 0
}), and checks a redirect's Location before anything requests it. A refused
target fails the call with FORBIDDEN; an allowed one becomes a fresh, checked
navigation (withPage follows main-frame hops itself, up to 20; past that,
BROWSER_TOO_MANY_REDIRECTS). Fulfilling the 3xx instead would not work: the
hop it triggers is auto-continued by Playwright and never reaches the handler.

The browsers launch() and connect() hand to caller code carry the same guard on
every context, including the contexts already open in a re-attached session.
Browser Run cannot tag a session with an owner, so the docs now state that a
session id is a bearer secret.

Also: a keepAlive session is closed when its callback throws; allowedHosts
entries are compared in punycode; a DoH answer with no address is refused.

The Node doubles now model Playwright's rule that a redirect hop never reaches
the interceptor (__tests__/_helpers/fake-launch.ts), with a regression test for
a public URL 302ing to 10.0.0.5. The workerd suite's DoH and /crawl paths run on
workerd's own fetch against a fake internet (miniflare outboundService) instead
of a stubbed global, and drops two input-guard tests the Node suite covers.
* **x402:** BrowserContextLike requires route; PageLike drops route and
gains an optional mainFrame; RouteLike gains fetch and fulfill and is generic
over the response type. Test doubles passed as launch/connect need a context
with route; the real @cloudflare/playwright exports are unaffected.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* fix(x402): map facilitator failures to 502 and stop a pre-paid leak

@x402/core rethrows a FacilitatorResponseError (malformed or timed-out
/verify or /settle answer) out of processHTTPRequest / processSettlement, so it
reached the host as an anonymous 500. The charge middleware now throws
LunoraError X402_FACILITATOR_ERROR (502) with the handler not run; on
settle-after the resource is withheld. Initialisation maps an unreachable
facilitator to the same code and a facilitator that does not settle the network
(RouteConfigurationError) to ENV_INVALID.

A request that already carries PAYMENT-SIGNATURE / X-PAYMENT is now sent as-is.
@x402/fetch answered its 402 by reserving against maxPerRun, signing, then
throwing "Payment already attempted" with the reservation held for the rest of
the run.

maxPerRun's docstring said "wallet lifetime"; it is one rail, which for
ctx.x402 is one function invocation. WalletDeps and GetSecret are gone: wallet.ts
reads getSecret off X402PayDeps.

Tests: facilitator failures at verify, settle and init; ENV_INVALID asserted on
network and recipient errors; the always-passing stray-decimals test dropped;
a workerd case for the pre-paid request. The workerd suites share one facilitator
double (_facilitator.ts) and the Solana challenge moved to the smoke suite.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* fix(codegen): gate ctx.x402 on the secrets capability

ctx.x402 was classified credential-based (x402: null) and emitted on every
target, but the generated rail reads its wallet key through ctx.secrets, which
node and celld rate unsupported: raw-key and CDP custody failed on the first
payment with no build-time signal. It now maps to the secrets feature, so those
targets withhold ctx.x402 with platform_unsupported_feature. Signer custody
still works there through createX402Pay called directly.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* docs(x402,browser): correct the guard, error and platform claims

browser: the README and docs no longer say the guard re-checks every redirect
hop through page.route; they describe the fetch-and-check navigation guard, its
cost (documents are fetched by the Worker), the sub-resource redirects it cannot
see, session ids as bearer secrets, ports not being restricted by allowedHosts,
and DoH answers with no address being refused.

x402: the errors section no longer claims every error is a LunoraError or that
every payment failure is a 402; it lists X402_FACILITATOR_ERROR and what passes
through from @x402/fetch. The platform table follows the codegen secrets gate.
maxPerRun is documented as per invocation, with a durable counter checked in
onPaymentRequired as the way to a cross-run budget.

Also: the from-alpha migration notes cover both packages' breaks, ROADMAP's
experimental-heavy example no longer names browser, and plan 463 marks B3 done
for code, pending maintainer sign-off on bar item 5.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* fix(notify): refuse a send when the DoH re-check cannot complete

shared/ssrf-resolve returned the same "unknown" verdict for an IP-literal host
and for a lookup that failed (timeout, network error, non-200, bad body), and
callers passed both on the string guard. The name's own nameserver can stall the
check on purpose, so that let a rebinding host through. The verdict is now
"skipped" for an IP literal and "failed" for a lookup that could not complete;
one failed address family is enough, since a stalled A lookup next to a public
AAAA answer says nothing about the address the connection will use.

@lunora/notify refuses "failed" like "unresolved" (fail closed) and caches
neither, so the next send after an outage re-checks. The cost is that a DoH
outage stops web-push sends to hosts without allowedPushOrigins; the
allowlist, which skips the re-check, remains the way to avoid it.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* fix(browser): check sub-resource redirects and lock the handed-out guard

Three SSRF gaps from the security review.

DNS fail-open: a DoH lookup that failed or timed out fell back to the string
guard. It now refuses with FORBIDDEN ("DNS ... could not be verified").
Verdicts are cached per hostname for 30s within one guarded context (failed
ones evicted), so a page's hundred assets from one CDN cost one lookup.

Sub-resource redirects: a non-navigation request got a string check and
route.continue(), so <img src> on a public page could 302 to the metadata
endpoint and render into a screenshot. Without allowedHosts, sub-resources now
get every guard (DNS included) and are fetched by the guard with
route.fetch({ maxRedirects: 0 }); each Location is checked and followed with
route.fetch({ url, maxRedirects: 0 }) up to 20 hops, a protocol change is
refused (route.fetch cannot follow it), and the final response is fulfilled.
WebSockets, which never reach a route handler, are checked through
routeWebSocket before they connect. With allowedHosts, Browser Run's session
guardrails enforce the list on every request and hop, so requests are checked
and left in the browser; this also restores the Tunnel config (an internal
host on the allowlist), which Worker-side fetching broke.

Guard lifetime: the browser from launch()/connect() is locked by pinning
members on the live objects (same instance however reached: page.context(),
browser.contexts(), popups via the context's page event). unrouteAll(),
unroute() without a handler, routeFromHAR(), routeWebSocket(), newCDPSession()
and newBrowserCDPSession() throw FORBIDDEN; caller route handlers keep working
but their continue() falls through to the guard and route.fetch() is refused.
Found while doing this and fixed: a caller route registered after the guard ran
first and could continue() past it. A context another connection opens is
withheld from contexts() until its guard lands. This holds against the public
Playwright API, not code reaching its private channels; allowedHosts is the
hard guarantee, as the docs say.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* fix(browser): follow redirect hops like a browser and block workers

Three findings from the security review of aaf603cd6.

Credential leak on redirect: route.fetch({ url }) reuses the original
request's method, headers and body, so a sub-resource hop to another origin
carried Authorization (and any page-set credential header) there, and a POST
answered with 302/303 was re-posted. Each hop is now built by browser rules: a
303 of anything but GET/HEAD and a 301/302 of a POST become a body-less GET; a
cross-origin hop drops Authorization, Proxy-Authorization and Cookie (the
request client re-derives cookies from the jar for the new URL), sends an
opaque Origin and cuts Referer back to its origin.

Authorization state drift: Playwright's request client already stores every
hop's Set-Cookie in the context's jar (context.addCookies) when it fetches.
Fulfilling the final response with its Set-Cookie made Chromium store a second
copy under its own parsing, so a session cookie could exist twice with
diverging attributes. Fulfilled Worker-fetched responses now drop Set-Cookie.

Guard bypass: Playwright's route handlers never see a request a service worker
handles, so a page's worker could fetch a private host and hand the body back
to be rendered. Every context the factory opens, and every one opened from a
guarded launch()/connect() browser, is created with serviceWorkers: "block".
Other candidates (relative and credentialed Location, data:/blob:, srcdoc and
about:blank frames, meta refresh, cache keying, allowPrivateTargets with
allowedHosts) checked out as covered.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* chore(api): keep browser experimental pending a live Browser Run check

Maintainer decision on plan 463 B3: graduate x402 only. browser moves back to
TIER_3 and the experimental lists (ROADMAP, versioning page, README banner)
until the live smoke test passes against a real Browser Run binding: the guard
now rests on route.fetch inside a real session, and the service-worker,
prerender and WebRTC paths are unverified on the real service.

Its exports stay untagged and its snapshot joins container's in
FULLY_TRACKED_SNAPSHOTS, so a tag cannot creep back while it waits. It keeps
its workerd CI leg. The ROADMAP row marks bar item 2 as partial, and plan 463
lists browser as pending live Browser Run verification.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* feat(browser): warn once when a factory runs without allowedHosts

allowedHosts, which Browser Run enforces on the session itself, is now the
documented production configuration. Without it the SSRF guard is a
best-effort check in the Worker, with known limits: speculation-rules
prerenders and WebRTC are not routed, the scope of Domain-less cookies stored
by the request client is unverified, the handed-out lock holds against the
public Playwright API only, and every page asset costs a Worker subrequest.

createBrowser() built without allowedHosts (and without allowPrivateTargets,
which opts out on purpose) warns once per isolate, pointing at allowedHosts,
the same way @lunora/notify warns about a missing allowedPushOrigins. The docs
and README gain a "Production posture" section listing those limits.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* fix(advisor): only allowedHosts contains an arg-derived browser URL

browser_user_url_without_allowlist (WARN) suppressed its findings when the
app's createBrowser pinned resolveDns: true. The DoH re-check is on by default
anyway, and without allowedHosts the whole guard is a best-effort Worker-side
check, so an args-derived URL reaching ctx.browser under it is exactly what the
lint should keep visible. Only allowedHosts, which Browser Run enforces on the
session, suppresses it now.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* test(browser): add a live Browser Run smoke Worker, ready to run

packages/browser/smoke is a Worker that drives the SSRF guard against a real
Browser Run binding, serving its own attacker-like fixtures so nothing
third-party is needed. GET /report answers a JSON pass/fail report:

- default mode: a guarded screenshot (route.fetch/fulfill inside a real
  session), an <img> that 302s to 169.254.169.254 failing with
  BLOCKED_BY_CLIENT, a main-frame redirect to 10.0.0.1 refused, service-worker
  registration blocked, and a cross-origin hop (to this version's preview URL)
  arriving without Authorization;
- allowedHosts mode: an allowed host loads, an off-list host is refused.

scripts/browser-smoke.sh deploys it with wrangler, curls /report and exits
non-zero on any failure. It was not run: it needs a Workers Paid account with
Browser Run. A wrangler --dry-run bundle succeeds. The smoke source is
typechecked and linted with the package (tsconfig include) but is not
published (files: dist) or built (packem bundles src/index.ts only). Teardown:
wrangler delete --config smoke/wrangler.jsonc.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

* fix(errors): register the x402 facilitator and browser redirect codes

`X402_FACILITATOR_ERROR` (internal, 502) and `BROWSER_TOO_MANY_REDIRECTS` (502) were minted
without catalog entries, which the catalog-registration test rejects. Also drops a leftover diff3
marker from the rebase in the upgrade guide.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019eqAUAYWECEXnGUUr8A1Fr

### Features

* **x402:** graduate to stable adapter; harden browser, keep it experimental (plan 463 B3) ([#1031](https://github.com/anolilab/lunora/issues/1031)) ([0b854d3](https://github.com/anolilab/lunora/commit/0b854d311aa54fe4bd78054aff800cd296b1f140))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.51

## @lunora/browser [1.0.0-alpha.60](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.59...@lunora/browser@1.0.0-alpha.60) (2026-10-03)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.50

## @lunora/browser [1.0.0-alpha.59](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.58...@lunora/browser@1.0.0-alpha.59) (2026-10-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.49

## @lunora/browser [1.0.0-alpha.58](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.57...@lunora/browser@1.0.0-alpha.58) (2026-09-30)

### Features

* cloudflare parity 1/3 — workflows, containers, browser run, tracing, ai, bindings ([#914](https://github.com/anolilab/lunora/issues/914)) ([e5297a9](https://github.com/anolilab/lunora/commit/e5297a97527f0863457e234e739a554b466750d1))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.48

## @lunora/browser [1.0.0-alpha.57](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.56...@lunora/browser@1.0.0-alpha.57) (2026-09-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.47

## @lunora/browser [1.0.0-alpha.56](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.55...@lunora/browser@1.0.0-alpha.56) (2026-09-27)

### Miscellaneous Chores

* drop unused devdependencies and a dead script ([#876](https://github.com/anolilab/lunora/issues/876)) ([e2e947f](https://github.com/anolilab/lunora/commit/e2e947f842c7115b99481c08dd7ca9ed49961f9f))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.46

## @lunora/browser [1.0.0-alpha.55](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.54...@lunora/browser@1.0.0-alpha.55) (2026-09-27)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.45

## @lunora/browser [1.0.0-alpha.54](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.53...@lunora/browser@1.0.0-alpha.54) (2026-09-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.44

## @lunora/browser [1.0.0-alpha.53](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.52...@lunora/browser@1.0.0-alpha.53) (2026-09-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.43

## @lunora/browser [1.0.0-alpha.52](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.51...@lunora/browser@1.0.0-alpha.52) (2026-09-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.42

## @lunora/browser [1.0.0-alpha.51](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.50...@lunora/browser@1.0.0-alpha.51) (2026-09-24)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.41

## @lunora/browser [1.0.0-alpha.50](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.49...@lunora/browser@1.0.0-alpha.50) (2026-09-24)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.40

## @lunora/browser [1.0.0-alpha.49](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.48...@lunora/browser@1.0.0-alpha.49) (2026-09-23)

### Bug Fixes

* **agent:** stop sandbox tools re-running billed side effects ([#786](https://github.com/anolilab/lunora/issues/786)) ([95bd227](https://github.com/anolilab/lunora/commit/95bd2270046d700993cd6c50bf27d7840b49008a))

## @lunora/browser [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.47...@lunora/browser@1.0.0-alpha.48) (2026-09-13)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.39

## @lunora/browser [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.46...@lunora/browser@1.0.0-alpha.47) (2026-09-13)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.38

## @lunora/browser [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.45...@lunora/browser@1.0.0-alpha.46) (2026-09-12)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.37

## @lunora/browser [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.44...@lunora/browser@1.0.0-alpha.45) (2026-09-12)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.36

## @lunora/browser [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.43...@lunora/browser@1.0.0-alpha.44) (2026-09-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.35

## @lunora/browser [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.42...@lunora/browser@1.0.0-alpha.43) (2026-09-06)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.34

## @lunora/browser [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.41...@lunora/browser@1.0.0-alpha.42) (2026-09-06)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.33

## @lunora/browser [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.40...@lunora/browser@1.0.0-alpha.41) (2026-09-05)

### Bug Fixes

* **client,react:** encode SSR payloads and stop three surfaces silently blanking ([#607](https://github.com/anolilab/lunora/issues/607)) ([a17366a](https://github.com/anolilab/lunora/commit/a17366a43ca0ea2a69f05912d68a678a0450c270))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.32

## @lunora/browser [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.39...@lunora/browser@1.0.0-alpha.40) (2026-09-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.31

## @lunora/browser [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.38...@lunora/browser@1.0.0-alpha.39) (2026-09-03)

### ⚠ BREAKING CHANGES

* `SubscriptionStore` requires `deleteOwned(id, userId)`. Both
shipped stores implement it; an external store must make the predicate and the
removal atomic rather than reintroduce the read-then-write race. Seeding a
`.unique()` self-referencing column into a non-empty table is now refused.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

### Bug Fixes

* close twelve review findings, three fail-open ([#587](https://github.com/anolilab/lunora/issues/587)) ([74c2ac0](https://github.com/anolilab/lunora/commit/74c2ac0028a77c357870ca120e0b76d65627581e))

## @lunora/browser [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.37...@lunora/browser@1.0.0-alpha.38) (2026-09-03)

### Bug Fixes

* audit rounds 14-16 ([#586](https://github.com/anolilab/lunora/issues/586)) ([6a09b74](https://github.com/anolilab/lunora/commit/6a09b746cfc9fb36f451c208b7a1c3eac16e56f4))

## @lunora/browser [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.36...@lunora/browser@1.0.0-alpha.37) (2026-09-03)

### ⚠ BREAKING CHANGES

* 34 public API changes across mail, storage, payment, replica,
studio, workflow, agent, codegen, cli and the shard runtime. The full list is in

### Bug Fixes

* audit rounds 7-11 ([#579](https://github.com/anolilab/lunora/issues/579)) ([224a42a](https://github.com/anolilab/lunora/commit/224a42a741f524e0110da55917c79fd08c90a885))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.30

## @lunora/browser [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.35...@lunora/browser@1.0.0-alpha.36) (2026-09-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.29

## @lunora/browser [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.34...@lunora/browser@1.0.0-alpha.35) (2026-09-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.28

## @lunora/browser [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.33...@lunora/browser@1.0.0-alpha.34) (2026-09-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.27

## @lunora/browser [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.32...@lunora/browser@1.0.0-alpha.33) (2026-08-29)

### ⚠ BREAKING CHANGES

* eleven packages now declare peerDependencies. Consumers that
relied on those packages resolving through hoisting must install them; the
alternative was shipping types that fail to resolve off this repo's node_modules.

`@lunora/workflow` is an optional peer of `@lunora/runtime`, so packem inlines
its types rather than importing them — the published `@lunora/runtime` carries no
`@lunora/workflow` dependency, as its source comments already promised.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AWDgSnuBJaeQHfEitB2zeL

* fix: satisfy eslint and the template matrix after the packem gate

Two CI failures from making packem warnings fatal, each a gate that the local
packem sweep does not cover.

`@lunora/advisor` back to a real dependency on `@lunora/errors`. `ae-metrics.ts`
imports `LunoraError` as a VALUE, and import/no-extraneous-dependencies requires
that for anything under `src/` regardless of whether the module reaches the
bundle. packem cannot see it because that module's value exports are
quarantined — `src/index.ts` re-exports only its types — so the throwing code is
tree-shaken out. The two rules disagree by construction; the packem side is now a
commented `unused` exclusion that says which condition would end it.

`@lunora/workflow` becomes a REQUIRED peer of `@lunora/runtime`. As an optional
peer it was auto-installed anyway, and every one of the twelve templates then
resolved `@lunora/workflow` from the npm REGISTRY instead of this checkout — the
scaffold matrix builds its local-tarball map from required peers only, on the
assumption that optional ones are never pulled in. Forcing the type to inline
instead (`resolveExternals.exclude`) does not work: that option governs the JS
bundle, and the declaration build has its own resolver, so the import survived.
A required peer matches the other seven packages here and keeps the type
resolvable for consumers.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AWDgSnuBJaeQHfEitB2zeL

### Build System

* ship .mjs everywhere and make packem warnings fatal ([#526](https://github.com/anolilab/lunora/issues/526)) ([b3eaacc](https://github.com/anolilab/lunora/commit/b3eaacc5a31fe4634a5f4a6c59fda6fbbc8315e1))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.26

## @lunora/browser [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.31...@lunora/browser@1.0.0-alpha.32) (2026-08-28)

### Documentation

* repair 404 package links, and document .source() in the hyperdrive readme ([#501](https://github.com/anolilab/lunora/issues/501)) ([d519ac2](https://github.com/anolilab/lunora/commit/d519ac23f2bd8ddf5a10af5db11f141e8728babf))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.25

## @lunora/browser [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.30...@lunora/browser@1.0.0-alpha.31) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.24

## @lunora/browser [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.29...@lunora/browser@1.0.0-alpha.30) (2026-08-26)

### Tests

* **browser:** move src suite to __tests__ ([#458](https://github.com/anolilab/lunora/issues/458)) ([09bd61d](https://github.com/anolilab/lunora/commit/09bd61d88733c25a239f9ec81f48dd28a2ec9d6c))

### Build System

* migrate to @cloudflare/vitest-plugin v1 ([#470](https://github.com/anolilab/lunora/issues/470)) ([05c4937](https://github.com/anolilab/lunora/commit/05c49371c30d65907eec8719f27a117f9bcaaefc))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.23

## @lunora/browser [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.28...%40lunora%2Fbrowser%401.0.0-alpha.29) (2026-08-14)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.22

## @lunora/browser [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.27...%40lunora%2Fbrowser%401.0.0-alpha.28) (2026-08-11)

## @lunora/browser [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.26...%40lunora%2Fbrowser%401.0.0-alpha.27) (2026-08-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.21

## @lunora/browser [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.25...%40lunora%2Fbrowser%401.0.0-alpha.26) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.20

## @lunora/browser [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.24...%40lunora%2Fbrowser%401.0.0-alpha.25) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.19

## @lunora/browser [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.23...%40lunora%2Fbrowser%401.0.0-alpha.24) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.18

## @lunora/browser [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.22...%40lunora%2Fbrowser%401.0.0-alpha.23) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.17

## @lunora/browser [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.21...%40lunora%2Fbrowser%401.0.0-alpha.22) (2026-08-07)

## @lunora/browser [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.20...%40lunora%2Fbrowser%401.0.0-alpha.21) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.16

## @lunora/browser [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.19...%40lunora%2Fbrowser%401.0.0-alpha.20) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.15

## @lunora/browser [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.18...%40lunora%2Fbrowser%401.0.0-alpha.19) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.14

## @lunora/browser [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.17...%40lunora%2Fbrowser%401.0.0-alpha.18) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.13

## @lunora/browser [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.16...%40lunora%2Fbrowser%401.0.0-alpha.17) (2026-08-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.12

## @lunora/browser [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.15...%40lunora%2Fbrowser%401.0.0-alpha.16) (2026-08-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.11

## @lunora/browser [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.14...%40lunora%2Fbrowser%401.0.0-alpha.15) (2026-07-31)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.10

## @lunora/browser [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.13...%40lunora%2Fbrowser%401.0.0-alpha.14) (2026-07-31)

## @lunora/browser [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.12...%40lunora%2Fbrowser%401.0.0-alpha.13) (2026-07-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.9

## @lunora/browser [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.11...%40lunora%2Fbrowser%401.0.0-alpha.12) (2026-07-26)

## @lunora/browser [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.10...%40lunora%2Fbrowser%401.0.0-alpha.11) (2026-07-25)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.8

## @lunora/browser [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.9...%40lunora%2Fbrowser%401.0.0-alpha.10) (2026-07-22)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.7

## @lunora/browser [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.8...%40lunora%2Fbrowser%401.0.0-alpha.9) (2026-07-20)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.6

## @lunora/browser [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.7...%40lunora%2Fbrowser%401.0.0-alpha.8) (2026-07-17)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.5

## @lunora/browser [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.6...%40lunora%2Fbrowser%401.0.0-alpha.7) (2026-07-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.4

## @lunora/browser [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.5...%40lunora%2Fbrowser%401.0.0-alpha.6) (2026-07-08)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.3

## @lunora/browser [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.4...%40lunora%2Fbrowser%401.0.0-alpha.5) (2026-07-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.2

## @lunora/browser [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.3...%40lunora%2Fbrowser%401.0.0-alpha.4) (2026-07-03)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.1

## @lunora/browser [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/%40lunora%2Fbrowser%401.0.0-alpha.2...%40lunora%2Fbrowser%401.0.0-alpha.3) (2026-07-02)

## @lunora/browser [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/@lunora/browser@1.0.0-alpha.1...@lunora/browser@1.0.0-alpha.2) (2026-06-27)

### Features

* **queue:** add queues, pipelines, secrets bindings + studio queues page ([#30](https://github.com/anolilab/lunora/issues/30)) ([131460c](https://github.com/anolilab/lunora/commit/131460c5826f2ef600fa0ef81248ede91835dd0c)), closes [#29](https://github.com/anolilab/lunora/issues/29) [#31](https://github.com/anolilab/lunora/issues/31) [visulima#714](https://github.com/visulima/visulima/issues/714)

### Miscellaneous Chores

* **deps:** wire fallow into every package ([896a81d](https://github.com/anolilab/lunora/commit/896a81d39a064293234bba3b734cde1036e81a67))
* update our og pacakge image ([63e6811](https://github.com/anolilab/lunora/commit/63e6811e2dfb94bc2cc38c05292b527e884660b5))

## @lunora/browser 1.0.0-alpha.1 (2026-06-21)

### Features

* publish all packages publicly for the initial alpha release ([91781b4](https://github.com/anolilab/lunora/commit/91781b485bf7a9891805c6851fe393de5f87ef40))

### Miscellaneous Chores

* lunora start ([786b573](https://github.com/anolilab/lunora/commit/786b5735d986bca4df64ccf642273a085bf7d574))
* normalize package.json key order ([d7a25f0](https://github.com/anolilab/lunora/commit/d7a25f00e0f665dd113ad17e98081b9bd69a1989))

### Continuous Integration

* rebuild test + lint pipelines on the visulima model (vis, no build job) ([#25](https://github.com/anolilab/lunora/issues/25)) ([63f7f88](https://github.com/anolilab/lunora/commit/63f7f88c0451f9ba1599780176b806a469f01ca6))
