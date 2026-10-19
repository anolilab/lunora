# Plan 534: CLI and config tooling fixes from the 2026-10-19 audit

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 2376f8799..HEAD -- packages/cli/src/util/spawn.ts packages/cli/src/util/studio-server.ts packages/cli/src/util/mcp-config-file.ts packages/config/src/studio-host/middleware.ts packages/config/src/cloudflare/credentials.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S–M (five S-sized fixes)
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug + security + perf
- **Planned at**: commit `2376f8799`, 2026-10-19
- **Issue**: https://github.com/anolilab/lunora/issues/1271
- **Platform parity**: not applicable

## Why this matters

The CLI spawner can drop the tail of a child's stdout (the deployed URL,
`wrangler secret list` JSON), the studio proxy kills any admin operation that
goes quiet for 30 s, the MCP config writer leaves third-party secrets
world-readable for a moment, the Studio document embeds a stale admin token
after `.dev.vars` changes, and an offline `wrangler whoami` probe stalls every
config load by up to 10 s per caller.

## Current state

Conventions from `CLAUDE.md`: relative imports WITHOUT `.js`; named exports
only; `eslint --max-warnings=0`; `alpha` branch, no compat shims.

### A. Spawner resolves on `exit`, not `close`

`packages/cli/src/util/spawn.ts:227-236`:

```ts
child.on("exit", (code, signal) => {
    resolve({
        code: code ?? (signal ? 1 : 0),
        stderr: descriptor.captureStderr === true ? capturedError + stderrDecoder.end() : undefined,
        stdout: wantCapture || wantSilentCapture ? captured + stdoutDecoder.end() : undefined,
    });
});
```

Node's `exit` can fire while piped stdio is still open; `close` fires after all
stdio streams end. Consumers that parse the buffer: `commands/deploy/handler.ts:467`
→ `post-deploy.ts:268` (`parseDeployedUrl`), `util/wrangler-secrets.ts:62`
(`JSON.parse`), `commands/doctor/fix.ts:75,98`. Test: `packages/cli/__tests__/util/spawn.test.ts`.

### B. Proxy timeout is an inactivity timer

`packages/cli/src/util/studio-server.ts:58,87-89`:

```ts
const PROXY_RESPONSE_TIMEOUT_MS = 30_000;
...
    upstream.setTimeout(PROXY_RESPONSE_TIMEOUT_MS, () => {
        upstream.destroy(new Error(`no response within ${String(PROXY_RESPONSE_TIMEOUT_MS)}ms`));
    });
```

`ClientRequest.setTimeout` is socket inactivity and stays armed after headers.
The upgrade leg (`:130`) already does `upstream.setTimeout(0)` once connected.
Tests: `packages/cli/__tests__/util/studio-server.test.ts`.

### C. MCP config temp file created with umask mode

`packages/cli/src/util/mcp-config-file.ts:65-68`:

```ts
writeFileSync(temporaryPath, contents, "utf8");

if (mode !== undefined) {
    chmodSync(temporaryPath, mode);
}
```

`contents` is the user's whole MCP client config (other servers' `env` keys).
`packages/config/src/scaffold-dev-variables.ts:329` shows the right shape:
`writeFileSync(temporaryPath, content, { encoding: "utf8", ...options })` with
`mode` in options. Test: `packages/cli/__tests__/util/mcp-clients.test.ts` (or
whichever test imports `mcp-config-file`: `grep -rl mcp-config-file packages/cli/__tests__`).

### D. Studio document caches the admin token for the session

`packages/config/src/studio-host/middleware.ts:231-233`:

```ts
        html ??= renderStudioHtml({
            adminToken: resolveAdminToken(projectRoot),
```

and `packages/cli/src/util/studio-server.ts:182-186` (rendered once at start).
The assets path in the same middleware (`:106-112`) re-reads on a disk stamp
change (`assetsStamp`). `.dev.vars` lives at `<projectRoot>/.dev.vars`
(confirm by reading `resolveAdminToken`). Tests: `packages/config/__tests__/studio-host/*`,
`packages/cli/__tests__/util/studio-server-cache.test.ts`.

### E. `wrangler whoami` probe timeout is re-paid per caller

`packages/config/src/cloudflare/credentials.ts:112-141`:

```ts
    const known = answers.get(projectRoot);

    if (known !== undefined && (!known.loggedOut || Date.now() - known.at < LOGGED_OUT_TTL_MS)) {
        return known.loggedOut;
    }
    ...
    const { stdout } = spawnSync(process.execPath, [script, "whoami", "--json"], { ..., timeout: 10_000 });
    const loggedOut = LOGGED_OUT.test(stdout);

    if (loggedOut || LOGGED_IN.test(stdout)) {
        answers.set(projectRoot, { at: Date.now(), loggedOut });
    }

    return loggedOut;
```

A timeout (no network while logged in) matches neither regex, is not memoised,
and is re-paid by every caller (`remote-bindings.ts:259`, `service-dev-config.ts:63`
per service, `vite/src/local-ai-binding.ts:64`). Test: `packages/config/__tests__/credentials.test.ts`.

## Commands you will need

| Purpose    | Command                                                                                                    | Expected                   |
| ---------- | ---------------------------------------------------------------------------------------------------------- | -------------------------- |
| Install    | `pnpm install --frozen-lockfile`                                                                           | exit 0                     |
| Build deps | `pnpm --filter "@lunora/cli..." run build`                                                                 | exit 0 (builds config too) |
| Test       | `pnpm --filter "@lunora/cli" run test -- <filter>` / `pnpm --filter "@lunora/config" run test -- <filter>` | all pass                   |
| Typecheck  | `pnpm --filter "@lunora/cli" run lint:types` (and config)                                                  | exit 0                     |
| Lint       | `pnpm --filter "@lunora/cli" run lint:eslint` (and config)                                                 | exit 0                     |

## Scope

**In scope**:

- `packages/cli/src/util/spawn.ts`, `packages/cli/__tests__/util/spawn.test.ts`
- `packages/cli/src/util/studio-server.ts`, `packages/cli/__tests__/util/studio-server.test.ts`, `studio-server-cache.test.ts`
- `packages/cli/src/util/mcp-config-file.ts` and the test that covers it
- `packages/config/src/studio-host/middleware.ts` and its test under `packages/config/__tests__/studio-host/`
- `packages/config/src/cloudflare/credentials.ts`, `packages/config/__tests__/credentials.test.ts`

**Out of scope**: every `packages/cli/src/commands/*` file; `packages/vite`;
`packages/studio`; exported types (no `api-snapshots` changes expected).

## Git workflow

- Branch: `fix/tooling-audit-2026-10-19` from `alpha`.
- One conventional commit per step, e.g. `fix(cli): settle spawned children on close so captured stdout is complete`.
- Do NOT push or open a PR.

## Steps

### Step 1: Settle on `close`

In `spawn.ts`: keep the `exit` listener but only record `code`/`signal` into
locals; move the `resolve({...})` into `child.on("close", ...)`. Guard against
double-settle (the `error` listener may already have rejected) with a
`settled` boolean. Test: spawn `process.execPath` with `-e` writing ~1 MB to
stdout immediately before `process.exit(0)`; with `captureStdoutSilently:
true` assert `stdout.length` equals the written length. Run it a few times in
the test (loop of 5) — the race is intermittent.

**Verify**: `pnpm --filter "@lunora/cli" run test -- spawn` → all pass.

### Step 2: First-byte timeout on the proxy

In `proxyHttp`, inside the response callback's first line add
`upstream.setTimeout(0);` and update the comment above the `setTimeout` call to
say the bound covers time-to-headers only. Test: an upstream that sends headers
immediately then a body chunk after > timeout (use a tiny timeout via a
module-level constant override — if the constant is not injectable, make
`proxyHttp` take an optional `timeoutMs` argument defaulting to the constant,
internal only) → the client receives the full body.

**Verify**: `pnpm --filter "@lunora/cli" run test -- studio-server` → all pass.

### Step 3: Create the temp file with the target mode

`writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: mode ?? 0o600 });`
and drop the `chmodSync` (rename preserves the temp file's mode; when `mode`
came from an existing target it is now applied at creation). Test: write to a
fresh path in a temp dir and assert `(statSync(path).mode & 0o777) === 0o600`
(skip on `process.platform === "win32"`).

**Verify**: `pnpm --filter "@lunora/cli" run test -- mcp` → all pass.

### Step 4: Re-render the Studio document when `.dev.vars` changes

In `middleware.ts`, replace `html ??=` with a stamp: read
`statSync(join(projectRoot, ".dev.vars")).mtimeMs` (0 when missing, wrapped in
try/catch) into `devVarsStamp`; re-render when it differs from the cached
stamp. Apply the same in `studio-server.ts` (`html` becomes a function of the
stamp, evaluated per `/` request). Keep the loopback gating exactly as is.
Test: render once, write a new `LUNORA_ADMIN_TOKEN` into the temp project's
`.dev.vars`, request `/` again → the document embeds the new token.

**Verify**: `pnpm --filter "@lunora/config" run test -- studio-host && pnpm --filter "@lunora/cli" run test -- studio-server` → all pass.

### Step 5: Memoise a silent `whoami`

In `credentials.ts`: lower `timeout` to `3_000`; when neither regex matches,
`answers.set(projectRoot, { at: Date.now(), loggedOut: false })` (fail-open:
treat as logged in, which is the documented policy) so the probe runs once per
process. Update the doc comment. Test: a stubbed `spawnSync` that returns empty
stdout is called once across two `wranglerSaysLoggedOut` calls.

**Verify**: `pnpm --filter "@lunora/config" run test -- credentials` → all pass.

## Done criteria

- [ ] `run test`, `run lint:types`, `run lint:eslint` exit 0 for `@lunora/cli` and `@lunora/config`
- [ ] `grep -n 'child.on("close"' packages/cli/src/util/spawn.ts` → one match
- [ ] `grep -n chmodSync packages/cli/src/util/mcp-config-file.ts` → no match
- [ ] `git status` shows no files outside scope

## STOP conditions

- Drift against the excerpts.
- Step 4: `resolveAdminToken` reads from somewhere other than `<projectRoot>/.dev.vars` — report the real source rather than guessing a stamp path.
- A verification fails twice.

## Maintenance notes

- `spawn.ts` is the single chokepoint for every CLI shell-out; any future `exit`-based logic must consider that `close` is the settle point now.
- The 3 s probe timeout is a trade-off: a slow-but-working network answers "logged in" (fail-open), which is the existing policy.
