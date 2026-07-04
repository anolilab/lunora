# Plan 134: `@lunora/x402` — agentic payments (charge + pay rails)

> **Executor instructions**: This is a FEATURE/DIRECTION plan — the deliverable
> is a shipped `@lunora/x402` package with two rails. Follow the phases in
> order, honor the STOP conditions, and update this plan's status row in
> `plans/README.md` when a phase lands. Phases 1 and 4 are the MVP; 2, 3, 5, 6
> are follow-ons that each stand alone.
>
> **Drift check (run first)**:
> `git diff --stat b7d361358..HEAD -- packages/payment/src packages/runtime/src/create-worker.ts packages/mcp/src packages/ai/src`
> Read the live shapes before designing on them — the RPC dispatch seam
> (`create-worker.ts`), the MCP server transport (`packages/mcp/src/server.ts`),
> and the action ctx (`packages/ai/src`) are the three integration points and
> may have moved.

## Status

- **Priority**: P2 (direction; strong strategic fit — machine-to-machine
  payments are the agent-native billing rail, and Cloudflare is standardizing
  it)
- **Effort**: L (new package, two rails, one runtime seam, one MCP-transport
  dependency)
- **Risk**: MED–HIGH. Charge rail handles money over a network boundary
  (verify/settle must be correct and fail-closed). Pay rail signs with a wallet
  key and spends autonomously — **spend caps + confirmation are load-bearing,
  not optional**.
- **Depends on**: Phase 3 (paid MCP tools) depends on a **remote MCP-over-HTTP**
  surface, which `@lunora/mcp` does not have today (it is stdio-only). That
  sub-goal is gated on building it — see Phase 3.
- **Category**: direction (feature)
- **Planned at**: commit `b7d361358`, 2026-07-04
- **Decisions locked** (from planning session): build **both rails**; ship as a
  **new `@lunora/x402` package** (not a `@lunora/payment` adapter, not folded
  into runtime/ai). Follow-up ruling (2026-07-04):
    - **Networks: multi-chain incl. Solana** — EVM via `@x402/evm` **and** SVM
      via `@x402/svm` (second, non-viem signing path). Base is still the primary
      test/prod EVM network.
    - **Facilitator: public `https://x402.org/facilitator` default, overridable**
      (self-hosted / CDP).
    - **Wallet custody (pay): both from day one** — raw key via
      `viem privateKeyToAccount(ctx.secrets…)` **and** CDP-managed via
      `@coinbase/x402`, behind one signer config.
    - **Package tag: `category:web3`.**

## Why this matters

x402 is HTTP-native machine-to-machine micropayment: an agent requests a
resource, gets `402 Payment Required` with a `PAYMENT-REQUIRED` header, signs a
stablecoin (USDC) payload, retries with an `X-PAYMENT` header, and the server
verifies + settles (via a **facilitator** that runs `/verify` and `/settle`
on-chain) and returns the resource with an `X-PAYMENT-RESPONSE` header. No
accounts, no API keys, no webhooks, no subscriptions — settlement is
per-request, onchain, sub-cent. Cloudflare has standardized it across Workers,
MCP tools (`paidTool`), and the Agents SDK client (`withX402Client`), and is
launching a hosted Monetization Gateway. For a Convex-class product on
Cloudflare, being able to **both charge agents and let your agents pay** is the
agent-native billing story that fiat PSPs (Stripe/Polar) structurally cannot
serve.

**Why a new package, not a `@lunora/payment` adapter.** `@lunora/payment` is a
fiat PSP abstraction: `PaymentAdapter` is `createCheckout` / `cancelSubscription`
/ `parseWebhook` / `refundPayment` / `reportUsage`, backed by a durable store on
`ctx.db`, a state machine, entitlements, and `dinero.js` money (ISO-4217 + bigint
minor units). x402 shares **none** of that surface — it is stateless
per-request onchain settlement with token base units on a network. Forcing it
into `PaymentAdapter` would pollute the fiat path and drag `viem`/chain deps
into a tree-shaken package. It is a separate rail.

## Reusable npm packages (verified against npm registry, 2026-07-04)

All `@x402/*` are **Apache-2.0** (compatible with the repo's
`FSL-1.1-Apache-2.0`). We write the Lunora glue and reuse the protocol/crypto:

| Package           | v      | Runtime deps                | Rail | Notes                                                                                                                                |
| ----------------- | ------ | --------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **`@x402/core`**  | 2.17.0 | `zod` only                  | both | Protocol engine. Subpaths: `./server`, `./client`, `./facilitator`, `./http`, `./schemas`, `./types`. The heart.                     |
| **`@x402/evm`**   | 2.17.0 | `viem`, `@x402/core`, `zod` | both | "exact-EVM" scheme: signing (pay) + payload decode/verify (charge). `viem` is workerd-first.                                         |
| **`@x402/fetch`** | 2.17.0 | `@x402/core` only           | pay  | `wrapFetchWithPayment` — client fetch wrapper. Optional (can drive `@x402/core/client` directly).                                    |
| **`@x402/svm`**   | 2.17.0 | `@solana/*`, core, zod      | both | Solana scheme (multi-chain ruling). Second, non-viem signing path.                                                                   |
| `@coinbase/x402`  | 2.1.0  | `@coinbase/cdp-sdk`, `viem` | pay  | **Optional peer** — required only for the CDP wallet-custody path (both custodies ship, but a raw-key user must not pull `cdp-sdk`). |

**Do NOT depend on:**

- **`agents/x402`** (Cloudflare, MIT) — the `withX402` / `paidTool` /
  `withX402Client` wrappers. Real, but bolted onto the `agents` SDK's
  `McpAgent`/`McpServer`. Per the standing decision Lunora does not adopt the
  `agents` SDK (Workflow-durable loop is our differentiator — see memory
  `reference-cloudflare-agents-sdk`). It is the **reference to port**; the
  wrappers are thin over `@x402/core`.
- **Legacy unscoped `x402` / `x402-hono` / `x402-fetch` / `x402-axios`**
  (v1.2.x) — superseded. Agents SDK v0.4.0 itself migrated off `x402` onto
  `@x402/core` + `@x402/evm`. Start on the v2 `@x402/*` line.

**Dependency caveats (both must be honored):**

- **zod version split.** `@x402/core` needs `zod@^3.24.2`; the repo catalog pins
  `zod@4.4.3`. `@x402/core`'s zod arrives **transitively** as a separate v3
  instance. **Do not import `zod` directly in `@lunora/x402`** — validate via
  `@x402/core/schemas` / the values you already own, or you get two zod
  instances and `instanceof` breakage. If direct schema validation is needed,
  use `@lunora/values` (`v.*`), not zod.
- **`viem` is net-new to the monorepo** (no package deps it today). Add it to
  the pnpm catalog (`catalog:dev` or a new `catalog:web3` key) — never hardcode
  the version. `@x402/evm` carries `viem` as a real dep, so `@lunora/x402`
  declares `@x402/evm`; `viem` need only be a direct dep where we call
  `privateKeyToAccount` (the pay rail).
- Workers-safety is **high-confidence but must be proven**: gate a workerd smoke
  (import `@x402/core/server` + `@x402/evm` in a DO and sign/verify once) in
  Phase 1 before building on it. See memory `project-workerd-sandbox-limit` —
  probe with `--no-coverage --project workerd` and gate on `LUNORA_WORKERD_TESTS=1`.

## Current state

- **No x402 anywhere**: `grep -rn "x402" packages apps plans` → 0 hits.
- **Charge attach points** (in fit order):
    - **HTTP-action routes** — plain HTTP request/response; the natural home for
      "gate an API / file / page." Smallest lift.
    - **Per-procedure** `query`/`mutation`/`action` — dispatched through a
      single `POST /_lunora/rpc` JSON envelope (`create-worker.ts:915`,
      `RPC_PATH`). A per-function paywall needs the runtime to translate
      "unpaid" into a **real HTTP 402 + `PAYMENT-REQUIRED` header** rather than
      an RPC error body — a runtime seam (Phase 2).
    - **MCP tools** — `@lunora/mcp` is a **local stdio** bridge (`Server` +
      `StdioServerTransport`, `packages/mcp/src/server.ts`). Cloudflare's
      `paidTool` is **remote MCP-over-HTTP inside a DO**. Charging MCP tools
      needs a remote HTTP MCP surface first (Phase 3, gated).
- **Pay attach point**: `@lunora/ai` actions do outbound calls; the wallet
  signer belongs on `ActionCtx` (crypto/network → action-only, same posture as
  `ctx.browser`/`ctx.sql`). Secret material via `ctx.secrets.get(...)`.
- Repo conventions that bind this plan: ESM `bundler` resolution (no `.js`
  extensions), named-exports-only when >1 export, `catalog:*` for shared dep
  versions, new package needs a `pnpm-workspace.yaml` `overrides` entry
  (memory `project-new-package-pnpm-overrides`), `sideEffects:false` + per-subpath
  exports for tree-shaking.

## Package layout

```
packages/x402/
  src/
    index.ts            # shared types re-export (X402Config, Network, Money-in-token-units)
    config.ts           # X402ChargeConfig / X402PayConfig, network + facilitator defaults
    facilitator.ts      # thin facilitator client over @x402/core/facilitator (verify/settle)
    charge/
      index.ts          # createX402Charge(config) → middleware factory
      middleware.ts     # 402 challenge → read X-PAYMENT → verify → run → settle → X-PAYMENT-RESPONSE
      http-action.ts    # adapter that wraps a Lunora httpRoute handler
      procedure.ts      # .x402({ price }) modifier + runtime-seam contract (Phase 2)
      mcp.ts            # paidTool port over the remote MCP surface (Phase 3)
    pay/
      index.ts          # createX402Pay(config) → { fetch, wrapClient, callTool }
      wallet.ts         # account from viem privateKeyToAccount(secret) | CDP (optional)
      fetch.ts          # wrapFetchWithPayment over @x402/fetch (or core/client)
      policy.ts         # onPaymentRequired confirmation + spend caps + max-price (fail-closed)
    receipt.ts          # normalized settlement receipt (for the Phase 6 bridge)
  __tests__/
```

Two consumer subpaths mirror Cloudflare's split: **`@lunora/x402/charge`**
(server, `withX402`-equivalent) and **`@lunora/x402/pay`** (client/agent,
`withX402Client`-equivalent). `.` re-exports shared config/types only.

## Phase 0 — Scaffold the package

1. `vis generate lunora-package --name=x402 --description='Agentic payments (x402) for Lunora — charge agents per request and let your agents pay x402-gated resources'`
2. Add `"@lunora/x402": "workspace:*"` to `overrides` in `pnpm-workspace.yaml`
   (new packages 404 on install otherwise — memory
   `project-new-package-pnpm-overrides`).
3. Deps: `@x402/core`, `@x402/evm`, `@x402/fetch`; `viem` (catalogued);
   `@lunora/errors`, `@lunora/values`. Optional peer: `@coinbase/x402`
   (`peerDependenciesMeta.optional`). Add `viem` to the pnpm catalog.
4. `project.json` tags: `type:package`, `category:payment` (or a new
   `category:web3`).
5. Subpath exports in `package.json` (`.`, `./charge`, `./pay`, `./package.json`),
   `sideEffects:false`.
6. **STOP** if `@x402/core`/`@x402/evm` fail to import under workerd (Phase 1
   smoke): re-evaluate the whole approach before writing glue.

## Phase 1 — Charge core + HTTP-action rail (MVP-A)

The reusable core does verify/settle; we own the Lunora request/response glue.

1. **`facilitator.ts`** — wrap `@x402/core/facilitator` into a
   `{ verify(payload, requirements), settle(payload, requirements) }` client.
   Default `facilitator.url = "https://x402.org/facilitator"`; allow override
   (self-hosted / CDP).
2. **`charge/middleware.ts`** — the state machine (shape; verify names against
   `@x402/core@2.17` `./server` + `./http` exports):
    - No/invalid `X-PAYMENT` header → build `PAYMENT-REQUIRED` from
      `{ network, recipient, price, resource }` via `@x402/core/server`, return
      `402` + header. **Fail-closed**: any construction error → 402, never
      resource.
    - `X-PAYMENT` present → `facilitator.verify()`; on fail → 402 with reason.
    - Verified → run the wrapped handler → `facilitator.settle()` → attach
      `X-PAYMENT-RESPONSE` to the success response. Settle failure after a
      successful handler is the **critical edge** — decide settle-before-run vs
      run-before-settle per scheme (`exact` can settle-after; `upto` settles at
      the end with the consumed amount). Document the choice; default `exact` +
      settle-after-run with idempotent settle.
3. **`charge/http-action.ts`** — wrap a Lunora `httpRoute` handler so
   `httpRoute.get(...).x402({ price })` (or a `withX402(handler, config)` call)
   gates it. This is the "gate an API/file/page" path and needs **no runtime
   change** — HTTP-action routes are already plain HTTP.
4. **Config**: `X402ChargeConfig = { network: "base" | "base-sepolia";
recipient: \`0x\${string}\`; facilitator?: { url: string }; price:
   TokenAmount }`. Server needs **only the recipient address** — no private key
(facilitator settles). Supply via a `config.x402(env)` thunk; recipient from
   a binding/var, not a secret.
5. **workerd smoke** (gated `LUNORA_WORKERD_TESTS=1`): import
   `@x402/core/server` + `@x402/evm`, build a challenge, verify a canned
   `base-sepolia` payload. Proves Workers-safety.
6. Tests: challenge shape, fail-closed on malformed header, verify-fail → 402,
   happy path attaches `X-PAYMENT-RESPONSE`, settle-failure handling.

**Done when**: an HTTP-action route can be gated behind a USDC price on
`base-sepolia`, a test agent (Phase 4) pays it end-to-end, and unpaid requests
get a spec-correct 402.

## Phase 2 — Charge: per-procedure `.x402({ price })` (runtime seam)

1. Add a `.x402({ price })` modifier to the `query`/`mutation`/`action` builders
   (`@lunora/server`) that tags the function with an x402 price (analogous to
   `.rls(...)`).
2. **Runtime seam** (`create-worker.ts`): before dispatching a tagged function
   over `POST /_lunora/rpc`, run the charge middleware; on "unpaid," return a
   **real `402` + `PAYMENT-REQUIRED`** response (not the JSON error envelope) so
   an x402 client sees the challenge. The Lunora client + `@lunora/x402/pay`
   must both understand a 402 on the RPC endpoint.
3. Decide the wire detail: RPC is a single POST; the `resource` identity in the
   challenge is the `functionPath`. Ensure batch RPC (`/_lunora/rpc-batch`) is
   either excluded or per-item gated (a batch mixing free + paid functions is a
   footgun — **default: reject paid functions in a batch**, document it).
4. **STOP** if this requires threading payment state through the shard-forward
   path (`create-worker.ts:1656` forwards to the shard DO) in a way that leaks
   the header past the origin worker — keep verify/settle at the **origin
   worker boundary**, before shard forwarding.

## Phase 3 — Charge: paid MCP tools (`paidTool` port) — GATED

**Blocked on a prerequisite.** `@lunora/mcp` is stdio-only; `paidTool` needs
remote MCP-over-HTTP (a client connects over HTTP and can carry `X-PAYMENT`).

1. Prereq: add a **remote HTTP (Streamable HTTP) MCP transport** to `@lunora/mcp`
   (today only `StdioServerTransport`). This is a standalone deliverable; file
   it separately if it grows.
2. Then port `paidTool`: a `paidTool(name, description, price, inputSchema,
annotations, handler)` that registers a tool whose dispatch runs the charge
   middleware first. Free `tool()` and `paidTool()` coexist on one server
   (mirror Cloudflare's `withX402(server, config)`).
3. Reuse the Phase 1 charge middleware — the only new part is mapping the MCP
   call/HTTP layer onto challenge/verify/settle.

## Phase 4 — Pay core + agent wallet (MVP-B)

1. **`pay/wallet.ts`** — resolve a signer: `privateKeyToAccount(secret)` (viem)
   where `secret` comes from `ctx.secrets.get(name)`; optional CDP-managed
   account via `@coinbase/x402` (optional peer). Wallet lives on **`ActionCtx`
   only** (crypto + outbound network → action-only, same as
   `ctx.browser`/`ctx.sql`).
2. **`pay/fetch.ts`** — `wrapFetchWithPayment` over `@x402/fetch` (or drive
   `@x402/core/client` + `@x402/evm` directly) so an action's outbound `fetch`
   auto-handles a 402: parse `PAYMENT-REQUIRED`, sign with the account, retry
   with `X-PAYMENT`.
3. **`pay/index.ts`** — `createX402Pay(config)` → `{ fetch, callTool,
wrapClient }`. `wrapClient` is the `withX402Client`-equivalent that wraps a
   Lunora MCP **client** connection so tool calls pay automatically.
4. Config: `X402PayConfig = { network; account | secretName; policy }`.
5. Tests against a mock facilitator + the Phase 1 charge server (loopback
   end-to-end on `base-sepolia` semantics without real chain — mock
   verify/settle).

## Phase 5 — Pay: policy (confirmation + spend caps) — SECURITY-CRITICAL

Autonomous spending needs guardrails **before** anyone runs the pay rail against
a real network:

1. **`pay/policy.ts`** — `onPaymentRequired(requirements) => Promise<boolean>`
   (human-in-the-loop / policy gate). `null` = auto-approve **only** under the
   caps below.
2. **Spend caps**: per-call `maxPrice`, per-window (e.g. per-run / per-hour)
   cumulative cap, and an allowlist of resources/recipients. **Fail-closed**:
   over cap or unknown recipient → refuse, do not sign.
3. Surface refusals as typed `LunoraError` (`@lunora/errors`) codes so callers
   can distinguish "declined by policy" from "network/verify failure."
4. Advisor lint candidate: flag an `@lunora/x402/pay` action with `policy: null`
   and no `maxPrice` (unbounded autonomous spend) — mirror the advisor posture
   used elsewhere.

## Phase 6 — Reporting bridge into `@lunora/payment` (optional)

1. **`receipt.ts`** — normalize each settlement into a
   `{ network, tx, from, to, amount, resource, ts }` receipt.
2. Optional sink: forward receipts to `@lunora/payment`'s **observability**
   (`PaymentObserver`) and/or a durable table, so x402 revenue/spend shows up
   next to Stripe/Polar in **Studio** — **without** coupling the rails (x402 is
   not a `PaymentAdapter`). Keep it a one-way, opt-in bridge.

## Codegen / config wiring

- Charge: no ctx needed for HTTP-action/procedure rails (config thunk). If a
  `ctx.x402.charge` ergonomic helper is wanted, codegen feature-probes for a
  `lunora/` import of `@lunora/x402/charge` (same pattern as `ctx.payments` /
  `ctx.ai`).
- Pay: codegen wires `ctx.x402` (or extends the pay signer onto `ActionCtx`)
  when a `lunora/` source imports `@lunora/x402/pay` — ActionCtx-only.
- Config layer (`@lunora/config`): validate/infer the recipient var + facilitator
  URL in `wrangler.jsonc`; scaffold `.dev.vars` for the pay wallet secret
  (memory: `.dev.vars` grammar + auto-scaffolder). Wallet key is a **secret**,
  recipient address is a **var**.

## Commands you will need

```bash
# Scaffold + link
vis generate lunora-package --name=x402 --description='…'
# then add overrides entry + viem to the catalog, pnpm install

# Build the package and its deps first (dist is gitignored)
pnpm --filter "@lunora/x402..." run build     # trailing ... includes deps
pnpm run build:packages                        # reliable fallback in a fresh worktree

# Test / typecheck / lint (single package)
pnpm --filter "@lunora/x402" run test
pnpm --filter "@lunora/x402" run lint:types
pnpm --filter "@lunora/x402" run lint:eslint

# workerd smoke (Phase 1) — probe before relying on it
LUNORA_WORKERD_TESTS=1 pnpm --filter "@lunora/x402" run test --no-coverage --project workerd
```

## Done criteria (MVP = Phases 0/1/4; ALL must hold)

- `@lunora/x402/charge` gates a Lunora HTTP-action route behind a USDC price;
  unpaid → spec-correct `402 + PAYMENT-REQUIRED`; paid → resource +
  `X-PAYMENT-RESPONSE`. Fail-closed on every error edge.
- `@lunora/x402/pay` (an action) pays that route end-to-end against a mock
  facilitator; real `base-sepolia` proven in a manual/integration check.
- Pay rail refuses when over `maxPrice` / spend cap / recipient allowlist
  (Phase 5) — no signature emitted.
- `@x402/core` + `@x402/evm` import and run under workerd (gated smoke green).
- No direct `zod` import in `@lunora/x402` (transitive v3 only); `viem`
  catalogued; `overrides` entry present; named-exports-only; no `.js`
  extensions; `sideEffects:false` + subpath exports.
- Build + typecheck + lint green for `@lunora/x402` and affected consumers.

## STOP conditions

- **Workers-unsafe core** — if `@x402/core`/`@x402/evm` can't run under workerd
  (node built-ins, unshimmed crypto), STOP and reassess (server-side verify may
  need to move to a facilitator-only path with no local `@x402/evm`).
- **Phase 2 runtime seam leaks payment state past the origin worker** into the
  shard-forward path — STOP; keep verify/settle at the origin boundary.
- **Phase 3 without a remote MCP transport** — do not fake paid MCP tools over
  stdio; build the transport first or defer.
- **Pay rail without Phase 5 caps against a real network** — never ship
  autonomous spend without spend caps + confirmation. Fail-closed by default.

## Open decisions (surface to the user before Phase 1 if unclear)

- **Networks**: `base-sepolia` (test) + `base` (prod) only to start, or
  multi-chain (`@x402/svm` for Solana) later? Default: EVM/Base first.
- **Facilitator**: public `x402.org/facilitator` default, with self-hosted /
  CDP override? Default: public, override-able.
- **Wallet custody (pay)**: raw private key in `ctx.secrets` (simplest) vs CDP
  managed (`@coinbase/x402`, optional peer, heavier)? Default: raw-key first,
  CDP as opt-in.
- **`category:web3`** new project.json tag vs reuse `category:payment`?
