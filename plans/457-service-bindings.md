# Plan 457 — Services: typed service bindings to sibling Workers

**Baseline:** `522a7799d` (2026-10-01)
**Status:** IN PROGRESS (phases 0–3 shipped; neore-v2 migration open)

## 0. Headline finding

Real Lunora apps already ship sibling Workers next to the Lunora backend. Lunora
has no concept of them, so each app rebuilds the same plumbing by hand, over the
public internet. The reference case is `anolilab/neore-v2`: five Hono Workers
under `services/`, each called from the backend through its public URL with a
per-service HMAC signature.

A Cloudflare **service binding** replaces all of that: no URL, no shared secret,
and no internet hop. Per Cloudflare's docs, the call runs "on the same thread of
the same Cloudflare server" and "requests … via a Service Binding do not incur
additional request fees".

So "service" in Lunora should mean **a separate Worker the app calls through a
service binding**, declared once and typed end to end. It is not a way to split
the Lunora app itself: components and modules stay inside the one Worker, with
shared transactions and live queries.

|                                   | Runs              | Shares db / transactions | Deployed     | For                                                    |
| --------------------------------- | ----------------- | ------------------------ | ------------ | ------------------------------------------------------ |
| Component (`defineComponent`)     | in the app Worker | yes                      | with the app | reusable features                                      |
| Module (`defineModule`, plan 456) | in the app Worker | yes                      | with the app | organising app code                                    |
| **Service (this plan)**           | its own Worker    | no — calls only          | on its own   | heavy / isolated work: rendering, parsing, LLM gateway |

## 1. Current state (audit)

### Lunora

- `services[]` in `wrangler.jsonc` is **validated but never generated**: shape
  only, in `packages/config/src/cloudflare/validate-bindings.ts:709-716`
  (`{ binding, service, entrypoint? }`). It's also listed in the Alchemy
  translation (`wrangler-to-alchemy.ts:202`) and in celld's accepted keys.
- There is no `ctx.services`, no codegen discovery, no Studio node, and no
  `PlatformCapabilities` row.
- `lunora.config.*` (`packages/codegen/src/project-config-file.ts:81-90`)
  carries `advisor`, `app`, `remote` and `target`, with no services.
- `@lunora/vite` builds the `cloudflare()` plugin options in
  `packages/vite/src/index.ts:192-212` and never passes `auxiliaryWorkers`.
  `@cloudflare/vite-plugin` 1.62 supports `auxiliaryWorkers` (`index.d.mts:142`):
  extra Workers run in the same dev session, with service bindings between them
  resolved in-process.
- `lunora deploy` deploys only the app Worker (`packages/cli/src/commands/deploy/handler.ts`).

### neore-v2 (`services/{browser-renderer,document-parser,embeddings,llm-gateway,nsfw-checker}`)

- Each service is a Hono / `@hono/zod-openapi` Worker with its own
  `wrangler.jsonc` (`env.production` / `env.preview`), deployed by Alchemy
  (`alchemy.run.ts:339-530`, `Worker(..., { cwd: "./services/<name>" })`).
- The backend calls them through `@neore/service-sdk`: generated OpenAPI clients
  plus `createHmacInterceptor`, sent to `*_URL` origins (`alchemy.run.ts:132-172`
  `serviceUrl`).
- **Five HMAC secrets, each set on both ends**, under names that differ per
  service (`DOCUMENT_PARSER_SIGNING_SECRET` → `PARSER_SIGNING_SECRET`,
  `NSFW_CHECKER_SIGNING_SECRET` → `NSFW_SIGNING_SECRET`, the rest → `SIGNING_SECRET`).
  `alchemy.run.ts:59-61` records the failure this causes: "all four services
  answered 503/401 to every call on a deploy that looked healthy."
- **Dev runs one process per Worker.** Inspector ports 9230–9235 are pinned per
  service, and a long comment in `backend/wrangler.jsonc` explains a boot-order
  port race. The root `dev` script starts the backend, web and two services
  through vis.
- `llm-gateway` is also called **from browsers**: a custom domain, plus allowed
  origins from `SITE_URL` (`alchemy.run.ts:504, 536-540`). Its public route has
  to stay.
- `embeddings` is deployed, but "nothing in the backend calls this service yet"
  (`alchemy.run.ts:416`).

## 2. Existing seams (do not reinvent)

- **Wrangler side:** `validate-bindings.ts`'s `services` rule already polices the
  shape, and the reconcile pipeline (`reconcile-bindings.ts`, the queue/cron
  reconcilers) is the pattern for writing entries Lunora owns.
- **Dev:** `@cloudflare/vite-plugin` `auxiliaryWorkers` runs sibling Workers in
  the dev session. For the `lunora dev` path, which runs wrangler, multiple `-c`
  configs give the same result.
- **Typing:** a service that exports a `WorkerEntrypoint` gives RPC types through
  `Service<typeof Entrypoint>`. A Hono app gives fetch types through `hc<AppType>`.
  Codegen already emits typed `ctx.*` fields from discovered declarations (the
  queues/topics/workflows pattern in `emit/shard-runtime.ts` + `emit/server.ts`).
- **Architecture:** plan 456's manifest (`shared/architecture-manifest.ts`) adds
  a `service` node kind and an `invoke` edge from `ctx.services.<name>.*` sites,
  through the existing `discover/call-edges.ts` surface matcher.
- **Platform:** `PlatformCapabilities` (`packages/platform/src/capabilities/`).

## 3. The behavioural contract to preserve

- An app that declares no service generates byte-identical `_generated/` output
  and the same `wrangler.jsonc`.
- A hand-written `services[]` entry Lunora did not create is never rewritten or
  removed. Reconcile owns only the bindings it declared, the same rule
  `queueTuning` uses.
- Services stay ordinary Workers. Lunora must not require a service to depend on
  any `@lunora/*` package.

## 4. Design decisions

### 4.1 Declared in `lunora.config.*`, not discovered from folders

```ts
// lunora.config.ts
export default defineConfig({
    services: {
        documentParser: { dir: "services/document-parser" }, // fetch (Hono)
        llmGateway: { dir: "services/llm-gateway", entrypoint: "Gateway" }, // RPC
    },
});
```

- **Chosen:** an explicit map, key → `{ dir, entrypoint? }`. The Worker name
  (`service`) is read from `<dir>/wrangler.jsonc`, so there's one source of truth
  for it.
- **Rejected:** auto-discover every `services/*/wrangler.jsonc`. Repos keep Workers
  the app does not call (neore's `embeddings`), and an implicit binding is a
  surprise permission.
- **Rejected:** declaring services in `lunora/`. A service is project topology,
  not app code, and `lunora/` is what codegen compiles into the app Worker.

### 4.2 `ctx.services.<name>` is the binding, typed

- **RPC service** (`entrypoint` set): `ctx.services.llmGateway.complete(...)`,
  typed from the service's exported `WorkerEntrypoint` class via
  `ServiceRpc<typeof import("<dir>/src/index").Gateway>` (shipped as `ServiceRpc`, see §11).
- **Fetch service** (no entrypoint): `ctx.services.documentParser.fetch(request)`.
  It is the raw `Fetcher`, so an existing Hono/OpenAPI client keeps working by
  passing `fetch: ctx.services.documentParser.fetch` (neore's generated SDK
  already accepts a custom fetch). There is no Lunora-specific client.
- Available on **actions and HTTP actions only**, like `ctx.browser` / `ctx.sql`:
  a cross-Worker call is non-deterministic I/O that a query re-run or a mutation
  rollback cannot undo.
- **Rejected:** a Lunora RPC wrapper with its own serialization. Cloudflare RPC
  already handles typed arguments, streams and errors.

### 4.3 No auth layer between app and service

- A service-bound Worker sets `workers_dev: false` and has no route, so the
  binding is its only way in. That's the point: delete the HMAC.
- A service that must also be public (neore's `llm-gateway`) keeps its own route
  and its own auth for that route. Lunora only binds the internal path.
- Lunora warns (`lunora doctor`) when a bound service still has `workers_dev`
  enabled and no route, which is the HMAC-era default that leaves it on the
  internet for nothing.

### 4.4 Dev and deploy

- **`lunora dev` / `vite dev`:** each declared service becomes an
  `auxiliaryWorkers` entry, or an extra `-c` on the wrangler path. All Workers run
  in one session with bindings resolved locally: one process and one inspector.
- **`lunora deploy`:** deploys declared services first
  (`wrangler deploy -c <dir>/wrangler.jsonc [--env]`), then the app, so a
  binding never points at a Worker that doesn't exist yet. `--env <name>` is
  passed through to each.
- **Alchemy users** (neore) keep `alchemy.run.ts`. The plan's deliverable for them
  is the binding wiring (`bindings: { DOCUMENT_PARSER: documentParser }`) plus
  removing secrets and URLs. Lunora's own deploy orchestration is for apps that
  don't use Alchemy.

### 4.5 What this is not

- Not a way to split the Lunora app into several Workers. That would drop shared
  transactions and live queries (see the analysis in plan 456 §4.5).
- Not service discovery across accounts, and not Workers for Platforms dispatch.
  `dispatch_namespaces` stays hand-written.

## 5. Workstreams

| #   | Work                                                                                                                                                                                                                                                            | Size |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| A   | `lunora.config.*` `services` schema (`project-config-file.ts`): `{ dir, entrypoint? }`, validated (dir exists, has a `wrangler.jsonc` with a `name`, entrypoint is an identifier)                                                                               | S    |
| B   | `@lunora/config`: reconcile `services[]` entries Lunora owns (binding `SERVICE_<NAME>`, `service` = the Worker name, `entrypoint`), record ownership like `queueTuning`, never touch hand-written entries; `env.<name>` blocks get the env-suffixed Worker name | M    |
| C   | `@lunora/codegen`: emit `ctx.services` on Action / HttpAction contexts, typed `Service<typeof Entrypoint>` or `Fetcher`; feature probe; architecture `service` node + `invoke` edges via `call-edges.ts`                                                        | M    |
| D   | `@lunora/platform`: `services` capability — native on cloudflare, native on celld (it accepts `services`; verify RPC entrypoints), unsupported on node (no second Worker to call)                                                                               | S    |
| E   | `@lunora/vite` + `lunora dev`: `auxiliaryWorkers` / multi-`-c` from the declared services                                                                                                                                                                       | M    |
| F   | `lunora deploy`: services-first ordering, `--env` pass-through, `--skip-services` escape hatch; `lunora doctor` warning for a bound service still on `workers_dev`                                                                                              | M    |
| G   | Studio: services as Architecture nodes with call edges; a "Services" row on the Home bindings overview                                                                                                                                                          | S    |
| H   | Docs (`concepts/services`), the `lunora-functions` skill, and a neore-v2 migration guide                                                                                                                                                                        | S    |

## 6. Platform parity

| Feature                                | `cloudflare` | `celld` | `node`      | Notes                                                                             |
| -------------------------------------- | ------------ | ------- | ----------- | --------------------------------------------------------------------------------- |
| `ctx.services.<name>` (fetch)          | native       | native  | unsupported | celld accepts the `services` key; Node has no sibling-Worker host                 |
| `ctx.services.<name>` (RPC entrypoint) | native       | verify  | unsupported | celld RPC entrypoint support to confirm in Phase 0; rate `unsupported` until then |

Host contract: none new. A service binding is a plain `Fetcher` / RPC stub on
`env`, with no `ShardHost` involvement. Codegen omits `ctx.services` with
`platform_unsupported_feature` on a host that rates it `unsupported`.

## 7. Phasing & ordering

| Phase | Work                                                                                                                    | Gate                                                                                                                                                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Spike: one fetch and one RPC service through `auxiliaryWorkers` in `lunora dev`, called from an action; check celld RPC | A workerd test: an action calls both services and gets typed results                                                                                                                                                 |
| 1     | A + B + C + D                                                                                                           | Golden: no-services app byte-identical; 2-service fixture reconciles `services[]` + emits typed `ctx.services`; hand-written entry untouched                                                                         |
| 2     | E                                                                                                                       | `lunora dev` on the fixture starts all three Workers in one process (smoke test in `tests/`)                                                                                                                         |
| 3     | F + G                                                                                                                   | `deploy --dry-run` lists services before the app; doctor test for the `workers_dev` warning; Studio component test                                                                                                   |
| 4     | H + the neore-v2 migration                                                                                              | neore-v2 runs `pnpm dev` with one command, its backend calls `document-parser` / `nsfw-checker` / `browser-renderer` / `llm-gateway` over bindings, and the four internal HMAC secrets plus `*_URL` vars are deleted |

## 8. neore-v2 migration (Phase 4)

1. `lunora.config.ts`: declare the four services the backend calls; leave
   `embeddings` out until something uses it.
2. Each service: `workers_dev: false` (except `llm-gateway`), and drop the HMAC
   middleware from the internal path. `llm-gateway` keeps HMAC and CORS on its
   public route only.
3. `@neore/service-sdk`: the clients take `fetch: ctx.services.<name>.fetch`
   instead of `baseUrl` + `createHmacInterceptor`. A later, optional step is to
   move hot paths to RPC entrypoints.
4. `alchemy.run.ts`: bind the services
   (`bindings: { DOCUMENT_PARSER: documentParser, … }`) and delete the four
   internal `*_SIGNING_SECRET` pairs, the `*_URL` values and `serviceUrl()`.
5. Dev: delete the per-service inspector ports and the boot-order comment in
   `backend/wrangler.jsonc`.

## 9. Risks & STOP conditions

- **STOP** if `auxiliaryWorkers` cannot load a service whose own `wrangler.jsonc`
  uses bindings Lunora's remote-bindings materialization rewrites (browser
  rendering for `browser-renderer`). Fall back to `-c` on the wrangler path
  only, and document `vite dev` as single-Worker.
- **Risk:** Smart Placement. neore places services with `placement.mode: "smart"`.
  A service binding runs the callee next to the caller unless the callee has its
  own placement. Confirm the callee's Smart Placement still applies through a
  binding, and say so in the docs.
- **Risk:** version skew at deploy. Services deploy first, so an app that starts
  calling a new RPC method before the service has it fails only if the deploy
  order is bypassed. `--skip-services` warns.
- **Perf watch:** none on the request path (same-thread call). Measure `lunora
dev` cold start with 4 auxiliary Workers against today's 5-process start.

## 10. Open questions

1. Do RPC entrypoints work on celld today? (Answer it in Phase 0.)
2. Should codegen read a fetch service's Hono `AppType` to type `fetch`
   end to end (`hc<AppType>`), or stay with `Fetcher` and let the app keep its own
   client? (Lean: stay with `Fetcher` in v1.)
3. Should `ctx.services` also be on mutations, for fire-and-forget calls? (Lean
   no: queue a job instead, which is replay-safe.)

## 11. What shipped (phases 0–3, docs of phase 4)

- **Phase 0:** a throwaway spike confirmed `auxiliaryWorkers` (vite) and
  `wrangler dev -c app -c svc` both resolve fetch and RPC service bindings
  locally. celld was not available, so **celld stays unverified** (fetch and
  RPC) and `PlatformCapabilities.services` rates it `unsupported`; `lunora
deploy` does not deploy services there either.
- **A:** `lunora.config` `services` read statically
  (`project-config-file.ts`); `discover/service-bindings.ts` resolves each entry
  against `<dir>/wrangler.jsonc` and throws, naming the entry, on anything it
  cannot wire.
- **B:** `reconcile-services.ts` writes `services[]` top level and in every
  declared `env.<name>` block (the service's `env.<name>.name`, else
  `<name>-<env>`). Ownership is `package.json` `lunora.services` (scope →
  binding names). Hand-written entries are never touched; one holding a
  declared binding is warned about. Remote-binding dev leaves owned services
  local.
- **C:** `ctx.services` is typed `ServiceFetcher | ServiceRpc<typeof Entry>`
  (`@lunora/server`) and built from `LUNORA_SERVICES` in the shard.
  **Deviation:** actions only, not HTTP actions. `HttpActionCtx` is a fixed type
  in `@lunora/server`, not codegen-emitted; an HTTP action reaches a service
  through `ctx.runAction`. Architecture: `service` nodes, `invoke` edges.
- **D:** cloudflare native; celld and node unsupported (celld until verified).
- **E:** `@lunora/vite` adds `auxiliaryWorkers` (keeping user entries);
  `lunora dev` passes one `--config` per service after the app's.
- **F:** `lunora deploy` deploys services first, with `--env` / `--dry-run`
  passed through. **Deviation:** the escape hatch is `--skip-services`, not
  `--only app`. A `--preview` or a non-Cloudflare target skips services with a
  warning. `lunora doctor` reports `service-workers-dev`.
- **G:** Studio Architecture draws service nodes; clicking one opens Functions.
  **Deferred:** the Home bindings card (it needs an admin endpoint for no
  information the diagram lacks).
- **H:** `concepts/services` (with the URL/HMAC migration), the
  `lunora-functions` skill section, and the `invoke` row in `concepts/modules`.
- **Tests:** `@lunora/server` has a `workerd` project calling a fetch service
  and a `WorkerEntrypoint` RPC service over real bindings (it also pinned why
  `fetch` must be bound: a detached `Fetcher.fetch` throws `Illegal invocation`).
  `examples/services` plus `tests/e2e/examples/services.spec.ts` call the same
  action through a live `vite dev` session. The `wrangler dev` flavor was run by
  hand with the same result.
- **celld, verified on v0.6.0:** both kinds work once each service is deployed
  into the same fleet / `celld dev` state as the app (celld resolves a binding
  from the target's `deploy/<name>/current.json`). Still rated unsupported:
  `lunora dev` and `lunora deploy` don't deploy services into celld yet.
- **Limits lifted after review:** `vite build` no longer builds services (the
  auxiliary Workers are added on `serve` only), and the SvelteKit / Nuxt sidecar
  runs them (reconcile writes `wrangler.dev.jsonc`'s `services[]`, ownership
  scope `dev:services`). Still open: an RPC service's sources join the app's
  type check.
- **Not done here:** the neore-v2 migration itself (another repo).
