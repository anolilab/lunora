# Plan 456 — Modules (formerly "services"): catalog, call graph, and an auto-drawn architecture diagram

**Baseline:** `30823cc90` (2026-10-01)
**Status:** IN PROGRESS (core shipped on `feat/services-catalog`; see below for what remains)

## What shipped, and where it differs from the design below

- **Renamed to "modules"** (`defineModule`, `lunora/<dir>/module.ts`,
  `cross_module_table_write`): they group code inside one Worker and are not
  deployment units, so "services" promised Encore-style isolation they do not have.

- **A, B, C, F, G, H shipped; D shipped in reduced form; E folded into D.**
    - `defineModule` in `@lunora/server`, `discover/modules.ts`, `discover/call-edges.ts`.
    - `src/architecture.ts` builds the manifest, which is served at
      `/_lunora/admin/architecture` and read by the client's `fetchArchitecture()`.
    - Studio has a **Functions → Architecture** tab, OpenAPI/OpenRPC are tagged by
      module, the `cross_module_table_write` lint exists, and there is a
      `concepts/modules` docs page.
- **The manifest is emitted only once an app declares a module** (§3). An app
  without one keeps byte-identical `_generated/` output, and the route answers an
  empty manifest.
- **A module's name is its folder path relative to `lunora/`** (`billing`, or
  `domains/billing`) rather than the last segment. That makes it unique by
  construction (changes §4.1).
- **Call edges are syntactic, with no type checker** (§8 STOP avoided). An edge
  whose target is held in a variable, and a call inside a non-exported helper,
  land in `unresolved`.
    - The one exception is `write` edges from by-id writes
      (`patch`/`replace`/`delete`/`hardDelete`/`restore`, `deleteMany`,
      `patchMany`): `discover/table-writes.ts` reads the table off the id's
      `Id<"table">` brand with the type checker. Batch-by-name and
      `ctx.db.<table>.*` facade writes are read syntactically.
    - Measured inside `runCodegen` (checker already warm from return-type
      inference) the walk costs 1–4 ms on team-chat, chess and blog, against
      ~800–900 ms of codegen — run-to-run noise is larger than the walk. A
      standalone walk on a cold checker is 130–200 ms, almost all of it checker
      start-up that codegen pays anyway.
    - An untyped id lands in `unresolved`; none of the examples have one.
- **HTTP routes are nodes, not `trigger` sources** (changes §4.3): a route is its
  own handler, so its calls start from the route node.
- **Studio (D/E):**
    - One lane per module, filterable by module (neighbours one edge away stay
      visible) and by edge kind.
    - The catalog table sits on the same page instead of in the Functions page (E).
    - Clicking a node opens its page (a table opens `/data?table=…`, the rest
      their listing tab), and the canvas exports to PNG/SVG/JSON through the
      export menu the schema diagram now shares (`components/diagram-export-panel`).
    - Not reused: the schema diagram's depth layout (lanes fit this graph better).
- **The fan-out lint now names topics in its wording.** Its detector already
  covered `ctx.topics.*.publish` (plan 455).
- **Installed components are modules too.** Each `defineSchemaExtension` key
  becomes an implicit module that owns its prefixed tables and the `lunora/<key>/`
  folder (where registry items copy their code). It gets its own Studio lane, and
  `cross_module_table_write` flags app code inserting into a component's table.
    - This runs even for apps with no declared module. Swept across all 13 examples:
      no new findings, and generated output unchanged.
    - A declared module of the same name, or a declared `tables` claim, takes
      precedence over the component.
    - The component's own `node_modules` code is not scanned.
- **Ownership is resolved once, before any consumer** (`resolveModules`): it
  merges in installed components and rejects nesting (components included), a
  table claimed twice or unknown, and a file beside a module that shares its tag
  (`lunora/billing.ts` next to `lunora/billing/`). A package component (code in
  `node_modules`) owns its tables but no `lunora/<key>/` folder.
- **Advisor `cacheKey`s for findings inside `export default …` change** from
  `<module>` to `default` (call sites there are now attributed), so a dismissed
  finding of that shape reappears once.
- **Not done:** the `lunora-functions` skill section, and per-module
  `queues.ts`/`topics.ts` discovery (§9 Q2).

## 0. Headline finding

Lunora has no service boundary. Codegen sees a flat set of `file:fn` functions, and
grouping metadata never reaches the IR. There is also **no general call graph**: the
only function → function edges recorded are `ctx.run*` calls inside queue/workflow
handlers (`PrivilegedDispatchIR`). Most of the pieces exist already, though:

- ts-morph discovery
- per-lint IRs for table reads/writes and workflow calls
- an xyflow ER diagram in Studio
- an admin route pattern for serving codegen output (OpenAPI/OpenRPC)

So Encore's "service catalog + Flow diagram" is mostly a join plus a renderer.

Scope is **metadata and visibility, not deployment**. Every service still ships in
the one Worker / one DO app. Encore deploys services separately; we deliberately do
not (§4.5).

## 1. Current state (audit)

- **Discovery** walks `lunora/` recursively with ts-morph, skipping `_generated`,
  `node_modules` and the root `schema.ts` (`packages/codegen/src/discover/ast.ts:30-38`, `:120`).
- **Naming is flat:** `sanitizeNamespace` (`packages/codegen/src/paths.ts:15`) drops
  a trailing `/index` and turns `/` into `_`. So `lunora/billing/invoices.ts` becomes
  `api.billing_invoices.*`, not `api.billing.invoices.*`.
- `ProjectIR` (`packages/codegen/src/ir.ts:2084`) holds crons, functions, httpRoutes,
  migrations and schema. Queues/workflows/agents/containers are separate IRs passed
  alongside (`run-codegen.ts:425`, `:947-951`).
- **Partial edge IRs that already exist:**
    - `PrivilegedDispatchIR` (`ir.ts:1686`): `ctx.run*(api|internal.x.y)`, but only inside queue/workflow handlers.
    - `WorkflowCallIR` (`ir.ts:801`): function → workflow.
    - `QueryReadIR` (`ir.ts:819`): function → table read.
    - `InsertWriteIR` (`ir.ts:882`): function → table write.
    - `procedure-middleware.ts:257` spots `runAfter`/`runAt`/`send` but drops the target.
- **Grouping concepts:** `definePlugin`/`defineComponent` (`packages/server/src/plugin.ts:263`, `:351`)
  bundle schema and functions for reuse. They carry no runtime isolation, and no IR metadata.
- **Studio:** one route per tab (`packages/studio/src/app/studio.tsx:1124`,
  tabs in `app/nav-types.ts:10`). `@xyflow/react` is already a dependency, used by the
  schema ER diagram (`features/schema/schema-diagram.tsx`, `layout.ts`,
  `diagram-export.ts`).
- **Admin routes:** codegen output is injected into the Worker and served verbatim,
  e.g. `handleOpenApi` (`packages/runtime/src/introspection-admin-routes.ts:171`).
- **OpenAPI/OpenRPC** tag operations by file namespace (`packages/codegen/src/openapi.ts:324`,
  `openrpc.ts:79`).
- No plan mentions services, a catalog or an architecture diagram.

## 2. Existing seams (do not reinvent)

- `discover/privileged-dispatches.ts`: generalize this, don't write a second resolver.
  It already resolves `api|internal.<file>.<fn>` to `targetFile`/`targetExport`.
- `QueryReadIR`, `InsertWriteIR`, `WorkflowCallIR`, `CronIR`, `QueueIR`, `httpRoutes`,
  and plan 455's topic/subscription IR. Join these. Don't re-walk the AST for them.
- The `openApiSpec` injection + admin route pattern for serving the manifest.
- The schema diagram's xyflow setup, depth layout and PNG/SVG export.

## 3. The behavioural contract to preserve

- An app with no `service.ts` file generates byte-identical `_generated/api.ts`,
  `server.ts` and `openapi.json` (golden fixture). Services are opt-in.
- `api.*` paths and `file:fn` dispatch paths do not change in v1 (§4.2).
- The architecture route is admin-gated like every `/_lunora/admin/*` route.

## 4. Design decisions

### 4.1 Explicit marker file, chosen over implicit top-level folders

```ts
// lunora/billing/service.ts
export default defineService({
    description: "Invoices, payments and dunning",
    tables: ["invoices", "payments"], // optional ownership, feeds the §4.4 lint
});
```

- **Chosen:** a folder becomes a service when it contains `service.ts`. Everything
  under it belongs to that service. Files outside any service go in an implicit `app`
  service. The name is the folder name, like Encore's `encore.service.ts`.
- `defineService` is a sole-default export, which the export rule allows.
- **Rejected:** every top-level folder is a service. Existing apps use folders for
  registry items (`lunora/ratelimit/`) that are not services, so it would relabel apps silently.
- **Rejected:** a `services: []` list in config. That's a second source of truth beside the folders.
- Nested services are not allowed (codegen error). The first `service.ts` on the path wins.

### 4.2 Naming stays flat in v1

Nested `api.billing.invoices.create` would read better. But changing `sanitizeNamespace`
reshapes every `api.*` path, every `file:fn` dispatch string, OpenAPI operation IDs and
non-JS SDK generators. That is a separate breaking change, with its own plan if wanted
(§9 Q1). Services ship as metadata first.

### 4.3 The call graph is a codegen artifact, not runtime tracing

- **Chosen:** static edges from ts-morph, emitted to `_generated/architecture.json`.
  They're deterministic, available before first deploy, and diffable in PRs.
- **Rejected:** deriving the graph from OTel traces. That only shows paths that ran,
  and needs traffic. Traces stay the runtime view (Studio Traces).
- Unresolvable targets (a computed ref, a ref passed in as an argument) are recorded as
  `{ to: null, reason }` and counted in Studio. They are never guessed.

Edge kinds:

| kind           | from              | to           | source                                                     |
| -------------- | ----------------- | ------------ | ---------------------------------------------------------- |
| `call`         | function          | function     | `ctx.runQuery/runMutation/runAction/run(...)`, any handler |
| `schedule`     | function          | function     | `ctx.scheduler.runAfter/runAt(ref)`                        |
| `read`/`write` | function          | table        | existing `QueryReadIR` / `InsertWriteIR`                   |
| `enqueue`      | function          | queue        | `ctx.queues.<q>.send/sendBatch`                            |
| `publish`      | function          | topic        | `ctx.topics.<t>.publish` (plan 455)                        |
| `subscribe`    | topic             | subscription | `defineSubscription(topic, …)`                             |
| `start`        | function          | workflow     | existing `WorkflowCallIR`                                  |
| `trigger`      | cron / http route | function     | `CronIR`, `httpRoutes`                                     |

### 4.4 Boundaries are advisor lints, not compile errors

- One new lint, `cross_service_table_write` (warning): a function writes a table whose
  `tables` ownership is declared by another service. It applies only where ownership is
  declared, so apps that don't opt in see nothing.
- **Rejected:** hard errors, or blocking cross-service `internal.*` calls. In Lunora
  `internal` means "not client-exposed", not "service-private". Making it mean both
  would break every existing app on day one.

### 4.5 No per-service deploy

One Worker and one DO class is the core Lunora model. Splitting deployment per service
would undo the shared-transaction story and is out of scope. If it's ever wanted,
`architecture.json` is the input it would need.

## 5. Workstreams

| #   | Work                                                                                                                                                                                                                                                   | Size |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| A   | `@lunora/server`: `defineService` (brand + validated `description`/`tables`). `@lunora/codegen`: `discover/services.ts` → `ServiceIR { name, dir, description, tables }`, file → service map, nested/duplicate errors                                  | S    |
| B   | `@lunora/codegen`: `discover/call-edges.ts`. Generalize `privileged-dispatches.ts` to every handler kind; add `scheduler`, `queues.send`, `topics.publish` targets; join the existing read/write/workflow/cron/http IRs → `EdgeIR[]`                   | M    |
| C   | Emit `_generated/architecture.json` (`{ version: 1, services[], nodes[], edges[], unresolved[] }`), inject it like `openApiSpec`, serve `/_lunora/admin/architecture` (admin-gated, empty-but-valid document when unset)                               | S    |
| D   | Studio **Architecture** tab: xyflow with services as group nodes and resources as children. Reuse `features/schema/layout.ts` and `diagram-export.ts`. Click a node to deep-link into Functions/Data/Queues/Workflows. Filter by service and edge kind | M    |
| E   | Studio Functions page: group and filter by service (catalog view), showing the service description and owned tables                                                                                                                                    | S    |
| F   | OpenAPI/OpenRPC: tag by service name when present, else by namespace as today                                                                                                                                                                          | S    |
| G   | `@lunora/advisor`: `cross_service_table_write` static lint + test                                                                                                                                                                                      | S    |
| H   | Docs page, `lunora-functions` skill section, api-snapshots                                                                                                                                                                                             | S    |

## 6. Platform parity

Not applicable: this adds no `ctx.*` surface and no binding. `defineService` is
build-time metadata, and the manifest is static JSON served by an existing admin-route
mechanism that works the same on every host.

## 7. Phasing & ordering

| Phase | Work  | Gate                                                                                                                                                        |
| ----- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | A     | Codegen golden: an app with no services is byte-identical; a 2-service fixture produces the expected `ServiceIR`; nested `service.ts` errors                |
| 1     | B + C | Golden `architecture.json` for an example covering every edge kind in §4.3; an unresolvable ref lands in `unresolved[]`; route test (admin gate, empty doc) |
| 2     | D + E | Studio component tests for the Architecture tab (renders nodes/edges from a fixture manifest, filter works); `test:coverage` floor holds                    |
| 3     | F + G | OpenAPI golden with service tags; advisor lint test (fires on a declared-owner violation, silent with no ownership)                                         |
| 4     | H     | `api:check`, docs build                                                                                                                                     |

Plan 455 is not a dependency. `publish`/`subscribe` edges land with whichever plan ships second.

## 8. Risks & STOP conditions

- **STOP** if generalizing `privileged-dispatches.ts` needs type-checker resolution
  (`getTypeChecker`) on every file and codegen time on the largest example regresses by
  more than 20%. Fall back to syntactic matching of `api.`/`internal.` property chains,
  which is what it does today.
- **Risk:** the diagram is unreadable for big apps (hundreds of functions). Mitigate:
  collapse services by default, expand on click, and filter by edge kind. Add `elkjs` only
  if the depth layout demonstrably fails on the largest example.
- **Risk:** `architecture.json` leaks internal topology. Mitigate: admin-gated route only,
  never in the client bundle (assert in `dist:check`).
- **Perf watch:** codegen wall time on `examples/*` before and after workstream B (the
  existing codegen bench, or `time lunora codegen` on the largest example).

## 9. Open questions (answer during execution)

1. Do we want nested `api.billing.invoices.*` naming at all? (A separate breaking plan; see §4.2.)
2. Once services exist, should `queues.ts` / `topics.ts` / `crons.ts` be discoverable per
   service folder (`lunora/billing/topics.ts`) instead of root-only? Likely yes, and it
   would land as a follow-up to plans 455 and 456.
3. Should `lunora deploy` print a short architecture diff (new or removed edges) next
   to the schema-drift gate?
