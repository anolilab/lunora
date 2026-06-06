# Cirrus Component Registry — `cirrus add` (spec)

> Written 2026-06-06. The concrete plan for Cirrus's "component" story, resolving
> [`CONVEX-PARITY.md`](./CONVEX-PARITY.md) gap **#5**. Expands [`PLAN2.md`](./PLAN2.md) §3.6.
>
> **Decision:** Cirrus does **not** build Convex-style sandboxed runtime components. It
> builds the **kitcn/shadcn registry model** — `cirrus add <name>` scaffolds *user-owned*
> code into the project. See "Why not Convex components" below.

## Why not Convex components (the rejected model)

Convex `@convex-dev/*` components are **black-box, runtime-sandboxed npm packages**: each
gets its own tables / file storage / scheduled functions that the host app *cannot read*,
accessed only through an exported API, with the component's writes joining the caller's
transaction. That model is built for a **managed, multi-tenant backend running untrusted
third-party code**. Replicating it on Cirrus is the wrong trade:

- **Needs cross-DO transactions** (CONVEX-PARITY #2) — inherently hard on the DO-sharding
  substrate that gives Cirrus its scaling lead. We'd be building Cirrus's hardest unsolved
  problem just to host components.
- **Needs per-component storage isolation** — separate DO/D1 namespaces, a sandbox boundary.
- **Clashes with positioning** — Cirrus is *user-owned Cloudflare infra*; a black-box
  dependency you can't see or edit contradicts "you own your backend."
- **License** — Convex is FSL: ideas-only, can't vendor the implementation.

The sandbox's value (protecting invariants from untrusted code) does not apply when the
user owns and controls the whole deployment. **Won't-do.**

## The model we build (white-box, user-owned)

Like `shadcn/ui` and `kitcn`: `cirrus add <name>` **copies code into the user's project**.
It becomes *their* code — visible, editable, no version lock, no runtime isolation. Tables
merge into the app schema (auto-namespaced for collision safety); functions are discovered
by codegen. Upgrades re-run `add` and *reconcile* without clobbering the user's edits.

### Already shipped (the foundation — Phase B)

- **Plugin contract** — `definePlugin(key, { extension, middleware })`, `defineSchemaExtension(key, { tables })`, `defineComponent`, and `defineSchema(...).extend(ext)` (`packages/server/src/plugin.ts`).
- **Auto table-namespacing** — extension tables prefix to `${key}_table` at merge time, **runtime-enforced**; intra-extension relation/aggregate/rank/vector references rewritten; same-key collision throws.
- **Codegen `.extend()` discovery** — `discoverSchema` walks `.extend(...)` chains and emits the namespaced extension tables into `api.ts`/`dataModel.ts` (inline + same-project; cross-package deferred).
- **Middleware composition** — `c.query.use(plugin.middleware)` injects `ctx.api.<key>`.

### Remaining work

1. **Auto function-namespacing (codegen)** — a plugin/registry item ships queries/mutations;
   codegen should surface them under `api.<key>.*` and a typed `ctx.api.<key>` automatically,
   instead of the current manual re-export (`plugin.ts:214`). No runtime sandbox — just
   discovery + naming. This is the type-half of "components feel first-class."
2. **The `cirrus add <name>` registry** — the new CLI surface (below).

## `cirrus add` — CLI design

```bash
cirrus add ratelimit          # scaffold a registry item into cirrus/
cirrus add ratelimit --dry-run
cirrus add auth resend        # multiple; dependency-resolved
cirrus list                   # show available registry items
```

Pipeline (mirrors kitcn / shadcn registry + the existing `giget` init templates):

1. **Resolve** the item from the registry (default `gh:anolilab/cirrus/registry/<name>#alpha`
   via `giget`, same mechanism as `cirrus init` whole-project templates; `--source` override).
2. **Plan** — read the item's manifest (`registry.json`): files to write, target paths,
   peer deps, `wrangler.jsonc` bindings/triggers, and other registry items it depends on
   (transitively resolved). Print the plan; `--dry-run` stops here.
3. **Reconcile** — for each file:
   - new file → write under `cirrus/<name>/` (or the manifest's target).
   - existing file → **AST/section merge**, not overwrite. Schema goes through
     `vis generate`-style AST merge into `cirrus/schema.ts` (the cron/table generators
     already do this via `.vis/templates/_helpers/insert-*.ts`). Track ownership so a
     re-run updates only the generated regions and preserves user edits (a managed-block
     marker or a per-item lockfile recording the last-applied hash).
4. **Apply deps** — add npm/peer deps to `package.json`; `wrangler.jsonc` bindings/triggers
   reconciled by the existing `@cirrus/vite` cron-sync–style writer. Prompt before install.
5. **Codegen** — run codegen so the new tables/functions appear in `_generated/`.
6. **Report** — next steps (e.g. "wire `.use(ratelimit.middleware)`", "set `RESEND_API_KEY`").

### Registry item shape

```
registry/ratelimit/
  registry.json        # manifest: name, description, files[], deps[], bindings[], requires[]
  schema.ts            # defineSchemaExtension("ratelimit", { tables: { buckets: ... } })
  ratelimit.ts         # query/mutation/action + middleware (definePlugin)
  README.md
```

`registry.json` (sketch):

```jsonc
{
  "name": "ratelimit",
  "description": "Token-bucket / fixed-window rate limiting",
  "requires": [],                       // other registry items
  "deps": {},                           // npm deps to add
  "bindings": [],                       // wrangler.jsonc additions
  "files": [
    { "from": "schema.ts",    "to": "cirrus/ratelimit/schema.ts",  "merge": "schema-extension" },
    { "from": "ratelimit.ts", "to": "cirrus/ratelimit/index.ts",   "merge": "create-or-skip" }
  ]
}
```

### Ownership tracking

Re-running `cirrus add <name>` must not clobber user edits. Options (pick one):
- **Managed-block markers** in shared files (`// cirrus:ratelimit:start … :end`) — only the
  marked region is regenerated. Simple; visible.
- **Per-item lock** (`cirrus/.cirrus-registry.json`) recording each item's version + the hash
  of each generated file; on re-run, 3-way reconcile (base = last-applied, theirs = new,
  yours = current) and only touch unchanged regions; report conflicts.

Prefer markers for schema/section merges (matches the AST-merge generators) and the lock for
whole-file items.

## Non-goals (explicit)

- No runtime sandbox / isolated per-component storage.
- No cross-DO/component transactions (gap #2 stays a documented trade-off).
- No black-box versioned npm components — items are copied code the user owns.

## Sequencing

1. **Function-namespacing codegen** (unblocks "first-class component functions"; bounded, codegen-only).
2. **`cirrus add` MVP** — one registry item end-to-end (e.g. `ratelimit`, which already exists as `@cirrus/ratelimit`), `giget` fetch + AST schema-merge (reuse `.vis/templates/_helpers`) + dry-run.
3. **Manifest deps/bindings + ownership tracking + `cirrus list`.**
4. **Seed the registry** — auth, resend/mail, ratelimit, storage helpers (ride on §3.7 auth expansion).

## License note

This model is borrowable: kitcn/shadcn registry patterns are permissively licensed
(re-implementable; see `ECOSYSTEM-BORROW.md`), unlike the FSL Convex component runtime.
