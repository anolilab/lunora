# Plan 126: Register the codegen-plugin teardown so it also fires without an httpServer (middleware mode)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat b6eb48dcd..HEAD -- packages/vite/src/codegen-plugin.ts packages/vite/src/dev-state-plugin.ts packages/vite/__tests__/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `b6eb48dcd`, 2026-07-04

## Why this matters

The Lunora codegen Vite plugin wires ALL of its teardown — the `closed` flag,
clearing the debounce timer, dropping the cached ts-morph `Project`, removing
six watcher listeners — inside `server.httpServer?.once("close", …)`. In
middleware mode (`vite.createServer({ server: { middlewareMode: true } })`,
used by programmatic hosts and some meta-framework dev servers)
`server.httpServer` is `null`, so the optional chain silently registers
nothing: a pending debounce can fire codegen against a closed module graph /
dead hot channel, and the parsed `Project` + timer are held past the server's
life (a leak per restart in long-lived programmatic hosts). The dev-state
plugin has the same structural gap for clearing `.lunora/dev.json`.

## Current state

- `packages/vite/src/codegen-plugin.ts:588-608` (inside the `configureServer`
  post-hook's returned function):

    ```ts
    return () => {
        server.httpServer?.once("close", () => {
            closed = true;
            // Drop the reused Project so a restart rebuilds it fresh …
            cachedProject = undefined;
            if (debounceTimer) {
                clearTimeout(debounceTimer);
                debounceTimer = undefined;
            }
            server.watcher.off("add", onChange);
            server.watcher.off("change", onChange);
            server.watcher.off("unlink", onChange);
            server.watcher.off("add", onConfigChange);
            server.watcher.off("change", onConfigChange);
            server.watcher.off("unlink", onConfigChange);
        });
    };
    ```

- `packages/vite/src/dev-state-plugin.ts:~105-110` — the record clear:

    ```ts
    server.httpServer?.once("close", () => {
        if (recorded) {
            clearDevServerState(root, process.pid);
            recorded = false;
        }
    });
    ```

    (Its record _write_ already has a middleware-aware comment and a
    `printUrls` piggyback; only the clear is httpServer-gated.)

- Vite offers no per-dev-server "closed" plugin hook pre-`buildEnd`; the
  standard middleware-mode-safe pattern is watching **`server.watcher`'s
  `"close"` event** as a fallback (the watcher is always present and is
  closed by `server.close()`), or hooking `server.ws.on("close")`. Verify
  which events the repo's Vite version emits before choosing (Step 1).

- Existing plugin tests: `packages/vite/__tests__/` has dedicated suites for
  `codegen-plugin` (fake timers) and `dev-state-plugin` — model new tests on
  them; they construct mock `server` objects, so a mock with
  `httpServer: null` is cheap.

Conventions: no `.js` extensions; named exports; commit types include `fix`.

## Commands you will need

| Purpose        | Command                                                       | Expected on success |
| -------------- | ------------------------------------------------------------- | ------------------- |
| Build deps     | `pnpm --filter "@lunora/vite..." run build`                   | exit 0              |
| Vite pkg tests | `pnpm --filter "@lunora/vite" run test`                       | all pass            |
| Types / lint   | `pnpm --filter "@lunora/vite" run lint:types` / `lint:eslint` | exit 0              |

## Scope

**In scope**:

- `packages/vite/src/codegen-plugin.ts` (teardown registration + a `closed`
  guard before debounce-fired sends)
- `packages/vite/src/dev-state-plugin.ts` (clear-on-close fallback)
- `packages/vite/__tests__/` (new tests)

**Out of scope**:

- Any other plugin in the package (`studio-plugin`, `log-stream-plugin`, …) —
  audit-verified or separately owned.
- The codegen debounce/HMR logic itself.
- Changing when the dev-state record is _written_ (only the clear).

## Git workflow

- Branch: `advisor/126-vite-teardown-middleware`
- Suggested commit: `fix(vite): run plugin teardown in middleware mode (no httpServer)`.

## Steps

### Step 1: Pick the always-available close signal

Check the repo's Vite version (`grep '"vite"' packages/vite/package.json` and
the catalog) and confirm in its types which of these fires on
`server.close()` in middleware mode: `server.watcher.on("close")` /
`server.ws.on("close")`. Chokidar's watcher emits no `"close"` event in some
versions — if neither is reliable, use the composition approach: register the
teardown function once and call it from BOTH `httpServer.once("close")` (when
present) AND the plugin's `buildEnd`/`closeBundle` hooks, guarded by a
`tornDown` boolean so double-fire is a no-op.

**Verify**: state your chosen mechanism + evidence (type defs or Vite docs) in
the report.

### Step 2: Extract and re-register the teardown (codegen-plugin)

Extract the close-handler body into a local `const teardown = () => { … }`
with an idempotence guard (`if (closed) return; closed = true; …`). Register:

```ts
if (server.httpServer) {
    server.httpServer.once("close", teardown);
} else {
    <chosen middleware-mode signal>(teardown);
}
```

Additionally, guard the debounce-fired work: at the top of the debounced
callback that calls `invalidateGenerated()` / `notifyEnvironmentsAfterCodegen()`,
early-return when `closed` (find it by following `debounceTimer`'s
assignment). This makes the failure benign even if a host tears down without
any close signal.

**Verify**: `pnpm --filter "@lunora/vite" run test` → all pass.

### Step 3: Same treatment for dev-state-plugin's clear

Apply the same registration pattern to the `clearDevServerState` close
handler in `dev-state-plugin.ts` (guarded by the existing `recorded` flag,
which already provides idempotence).

**Verify**: `pnpm --filter "@lunora/vite" run test` → all pass.

## Test plan

New tests modeled on the existing suites' mock-server pattern:

1. **codegen-plugin, middleware mode**: mock server with `httpServer: null`;
   drive the configureServer hook, trigger a debounce, then fire the chosen
   close signal → assert the watcher `off` calls happened and a
   subsequently-fired debounce performs no send (fake timers).
2. **codegen-plugin, classic mode regression**: `httpServer` present → close
   fires teardown exactly once (double-close doesn't re-run it).
3. **dev-state-plugin, middleware mode**: record written (via the listening
   fallback path), close signal fires → `clearDevServerState` called.

## Done criteria

- [ ] `grep -n 'httpServer?.once' packages/vite/src/codegen-plugin.ts packages/vite/src/dev-state-plugin.ts` → no remaining sole-registration (each
      site is either branch-registered or accompanied by the fallback)
- [ ] `pnpm --filter "@lunora/vite" run test` → all pass incl. 3 new tests
- [ ] `lint:types` + `lint:eslint` exit 0
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The teardown block no longer matches the excerpt (plugin restructured).
- No reliable middleware-mode close signal exists in the pinned Vite version
  AND `buildEnd`/`closeBundle` don't fire on dev-server close either — then
  ship ONLY the `closed`-guard on the debounce callback (harm reduction) and
  report the registration gap.
- Fixing the tests requires changing the mock-server helper shared by other
  suites in a way that alters their behavior.

## Maintenance notes

- If the plugin ever gains more resources (sockets, child processes), they
  belong inside `teardown()` — it is now the single close path for both modes.
- Reviewers: confirm the idempotence guard — `httpServer.close` + the fallback
  may BOTH fire in some hosts.
