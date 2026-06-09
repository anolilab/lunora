# Cirrus Component Registry — `cirrus registry` (spec + status)

> Written 2026-06-06. The concrete plan for Cirrus's "component" story, resolving
> [`CONVEX-PARITY.md`](./CONVEX-PARITY.md) gap **#5**. (Expanded the retired PLAN2 §3.6 — the `add` registry — now shipped; see git history.)
>
> **Decision:** Cirrus does **not** build Convex-style sandboxed runtime components. It
> builds the **kitcn/shadcn registry model** — `cirrus add <name>` scaffolds _user-owned_
> code into the project. See "Why not Convex components" below.

## Why not Convex components (the rejected model)

Convex `@convex-dev/*` components are **black-box, runtime-sandboxed npm packages**: each
gets its own tables / file storage / scheduled functions that the host app _cannot read_,
accessed only through an exported API, with the component's writes joining the caller's
transaction. That model is built for a **managed, multi-tenant backend running untrusted
third-party code**. Replicating it on Cirrus is the wrong trade:

- **Needs cross-DO transactions** (CONVEX-PARITY #2) — inherently hard on the DO-sharding
  substrate that gives Cirrus its scaling lead. We'd be building Cirrus's hardest unsolved
  problem just to host components.
- **Needs per-component storage isolation** — separate DO/D1 namespaces, a sandbox boundary.
- **Clashes with positioning** — Cirrus is _user-owned Cloudflare infra_; a black-box
  dependency you can't see or edit contradicts "you own your backend."
- **License** — Convex is FSL: ideas-only, can't vendor the implementation.

The sandbox's value (protecting invariants from untrusted code) does not apply when the
user owns and controls the whole deployment. **Won't-do.**

## The model we build (white-box, user-owned)

Like `shadcn/ui` and `kitcn`: `cirrus add <name>` **copies code into the user's project**.
It becomes _their_ code — visible, editable, no version lock, no runtime isolation. Tables
merge into the app schema (auto-namespaced for collision safety); functions are discovered
by codegen. Upgrades re-run `add` and _reconcile_ without clobbering the user's edits.

### Already shipped (the foundation — Phase B)

- **Plugin contract** — `definePlugin(key, { extension, middleware })`, `defineSchemaExtension(key, { tables })`, `defineComponent`, and `defineSchema(...).extend(ext)` (`packages/server/src/plugin.ts`).
- **Auto table-namespacing** — extension tables prefix to `${key}_table` at merge time, **runtime-enforced**; intra-extension relation/aggregate/rank/vector references rewritten; same-key collision throws.
- **Codegen `.extend()` discovery** — `discoverSchema` walks `.extend(...)` chains and emits the namespaced extension tables into `api.ts`/`dataModel.ts` (inline + same-project; cross-package deferred).
- **Middleware composition** — `c.query.use(plugin.middleware)` injects `ctx.api.<key>`.

### Shipped

1. **Auto function-namespacing (codegen)** — a registry item's queries/mutations surface under
   `api.<key>.*` with a typed `ctx.api.<key>` automatically (a `cirrus/<key>/index.ts` collapses
   to `api.<key>.*`). No manual re-export.
2. **The `cirrus registry` command** — the full CLI surface (below), with a lock-aware upgrade
   path, a generated catalog, and CI type-checking of every shipped item.

The repo ships nine items: `ratelimit`, `presence`, `mail`, `storage`, `crons`, `auth`
(+ `auth-clerk` / `auth-auth0`), and `backup`.

## `cirrus registry` — CLI design

```bash
cirrus registry add ratelimit            # scaffold a registry item into cirrus/
cirrus registry add ratelimit --dry-run  # plan only; --diff previews the file changes
cirrus registry add ratelimit --overwrite  # force-take the incoming copy over local edits
cirrus registry add auth auth-clerk      # multiple; dependency-resolved (requires:[…])
cirrus registry list                     # show available registry items (remote catalog)
cirrus registry view ratelimit           # inspect an item (plan + file contents) without installing
cirrus registry build [--check]          # regenerate index.json from the item dirs (--check = CI guard)
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
  registry.json        # manifest (schema: registry/schema/registry-item.schema.json)
  schema.ts            # defineSchemaExtension("ratelimit", { tables: { buckets: ... } })
  ratelimit.ts         # query/mutation/action + middleware (definePlugin)
  README.md
```

`registry.json` — the shipped manifest shape (validated by `registry/schema/registry-item.schema.json`):

```jsonc
{
    "$schema": "../schema/registry-item.schema.json",
    "name": "ratelimit",
    "title": "Rate limit", // short label (shown in plan/list)
    "description": "Token-bucket / fixed-window rate limiting",
    "docs": "Attach .use(ratelimit.middleware) …", // post-install guidance
    "requires": [], // other registry items (resolved deps-first)
    "deps": {}, // npm deps → package.json dependencies
    "devDependencies": {}, // npm deps → package.json devDependencies
    "bindings": [], // wrangler.jsonc additions (array bindings merge)
    "envVars": [], // scaffolded into .dev.vars; { name, description?, value?, secret? }
    "files": [
        { "from": "schema.ts", "to": "cirrus/ratelimit/schema.ts", "merge": "schema-extension" },
        { "from": "ratelimit.ts", "to": "cirrus/ratelimit/index.ts", "merge": "create-or-skip" },
    ],
}
```

The catalog (`registry/index.json`) is generated from the item dirs by `cirrus registry build`
and CI-verified with `--check`.

### Ownership tracking (shipped: per-item lock)

Re-running `cirrus registry add <name>` does not clobber user edits:

- **Schema/section merges** carry `// cirrus:add:<key>` managed-block markers and are idempotent.
- **Whole files** use a per-item lock (`cirrus/.cirrus-registry.json`) recording the last-written
  content hash; on re-run a 3-way reconcile (base = lock hash, yours = on-disk, theirs = incoming)
  cleanly upgrades an unedited file, drops a `.new` sidecar on a real conflict, and refuses to
  touch a file cirrus never wrote. `--overwrite` forces theirs; `--diff` previews.

## Non-goals (explicit)

- No runtime sandbox / isolated per-component storage.
- No cross-DO/component transactions (gap #2 stays a documented trade-off).
- No black-box versioned npm components — items are copied code the user owns.

## Sequencing — all shipped

1. ✅ **Function-namespacing codegen** — items' functions surface under `api.<key>.*` + typed `ctx.api.<key>`.
2. ✅ **`cirrus registry add`** — giget fetch + AST schema-merge + `--dry-run`/`--diff`/`--overwrite`.
3. ✅ **Manifest deps/devDeps/bindings/envVars + lock-based ownership tracking + `list`/`view`/`build`.**
4. ✅ **Seeded the registry** — ratelimit, presence, mail, storage, crons, auth (+clerk/auth0), backup.

Growth from here is authoring more items + the deployable connector wrappers (#9).

## License note

This model is borrowable: kitcn/shadcn registry patterns are permissively licensed
(re-implementable; see `ECOSYSTEM-BORROW.md`), unlike the FSL Convex component runtime.
