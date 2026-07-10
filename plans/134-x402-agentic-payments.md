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
      `viem privateKeyToAccount(ctx.secrets…)` **and** CDP-managed, behind one
      signer config. **Revised 2026-07-04:** EVM raw-key ships now; CDP custody
      is deferred to a follow-up because it needs `@coinbase/cdp-sdk` (not
      `@coinbase/x402`, which turned out to be a facilitator-auth helper). Both
      remain recognised config shapes; the unwired one fails loudly.
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

| Package             | v      | Runtime deps                | Rail | Notes                                                                                                                                                                                                                                          |
| ------------------- | ------ | --------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`@x402/core`**    | 2.17.0 | `zod` only                  | both | Protocol engine. Subpaths: `./server`, `./client`, `./facilitator`, `./http`, `./schemas`, `./types`. The heart.                                                                                                                               |
| **`@x402/evm`**     | 2.17.0 | `viem`, `@x402/core`, `zod` | both | "exact-EVM" scheme: signing (pay) + payload decode/verify (charge). `viem` is workerd-first.                                                                                                                                                   |
| **`@x402/fetch`**   | 2.17.0 | `@x402/core` only           | pay  | `wrapFetchWithPayment` — client fetch wrapper. Optional (can drive `@x402/core/client` directly).                                                                                                                                              |
| **`@x402/svm`**     | 2.17.0 | `@solana/*`, core, zod      | both | Solana scheme (multi-chain ruling). Second, non-viem signing path.                                                                                                                                                                             |
| `@coinbase/cdp-sdk` | 1.51.2 | `viem`, `@solana/kit`, zod  | pay  | **Optional peer (EVM wired)** — the CDP **wallet** custody SDK, loaded lazily. Only the CDP signer path pulls it; raw-key/user-supplied-signer users don't. EVM `getOrCreateAccount` → a `ClientEvmSigner`; Solana still via the escape hatch. |
| `@coinbase/x402`    | 2.1.0  | `@coinbase/cdp-sdk`, `viem` | pay  | **Facilitator-auth helper, NOT a signer** — `createCdpAuthHeaders` / `createFacilitatorConfig` / `facilitator`. Use only for a CDP _facilitator_, not wallet custody (corrected 2026-07-04).                                                   |

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

## Phase 1 — Charge core + HTTP-action rail (MVP-A) — ✅ shipped (facilitator `a9054ea12`, middleware + http-action `3ab9af42d`)

> **Implemented.** `facilitator.ts` wraps `@x402/core` into a
> `{ verify, settle }` client defaulting to `https://x402.org/facilitator`
> (overridable). `charge/middleware.ts` is the fail-closed state machine
> (`createChargeMiddleware(config, routeOverrides?)` → `{ handle(request,
runHandler) }`): no/invalid `X-PAYMENT` → build the `PAYMENT-REQUIRED`
> challenge and return `402` **without** running the handler; verified → run,
> `settle` (`exact` + settle-after-run, idempotent), attach
> `X-PAYMENT-RESPONSE`. `charge/http-action.ts` (`withX402(handler, config)`)
> gates a Lunora `httpRoute` handler with no runtime change. Covered by
> `charge-flow.test.ts`, `middleware-helpers.test.ts`, `facilitator.test.ts`,
> `resource-server.test.ts`. The `catalog:web3` `viem` add + `overrides` entry +
> `sideEffects:false` subpath exports (`./charge`, `./pay`) all landed here.
>
> **workerd smoke deferred, not built** (Phase 1 item 5 + the Workers-safety
> caveat): the `@x402/core` + `@x402/evm` boot-under-workerd probe is not spun up
> because workerd pool boot is environment-dependent in this sandbox (memory
> `project-workerd-sandbox-limit`). **Re-probed 2026-07-10** (the storage workerd
> gate under `LUNORA_WORKERD_TESTS=1`): still hangs on connect-timeout, so the
> smoke remains deferred. The intent + the how-to (mirror @lunora/storage's
> two-project config) is recorded in `vitest.config.ts`; gate it on
> `LUNORA_WORKERD_TESTS=1` when a green pool is available. The Node unit suite
> proves the protocol glue against in-memory facilitator/account doubles.

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

## Phase 2 — Charge: per-procedure `.x402({ price })` (runtime seam) — ✅ shipped (2a `dbcd94a84`, 2b `ab3a10d3`)

> **Implemented**: the `.x402({ price })` builder modifier tags a
> query/mutation/action (2a, commit `dbcd94a84`), and the origin worker
> paywalls it (2b, commit `ab3a10d3`). Codegen needs **no change** — the tag
> rides along on the registered function object's identity (`fn.x402`, exactly
> like `fn.rls`), so `handleRpc` reads it off `options.functions[path].x402`.
>
> `@lunora/x402/charge` ships `createProcedureChargeGate(config)`: an injectable
> gate memoising one initialised charge middleware per `functionPath` (each
> bakes that function's price and its `functionPath` as the challenge
> `resource` — every RPC POSTs to the same `/_lunora/rpc`, so the URL can't tell
> two paid procedures apart). `@lunora/runtime` wires it via
> `WorkerOptions.x402Charge` (a **structural** type — the runtime never imports
> `@lunora/x402`, keeping viem/solana out of every worker bundle). Verify +
> settle stay at the **origin boundary** (`handleRpc`), before shard forwarding;
> `dispatch` (the shard forward) runs only after payment is verified — the shard
> never sees payment state, so item 4's STOP condition holds.
>
> **Fail-closed** (`resolveX402Charge`): a paid function with no gate configured
> → `500` config error (never served free); paid fan-out → `400` (one payment is
> for one resource, not N shards); paid function in a batch → `400` for the whole
> batch (one POST carries one `X-PAYMENT`). Covered by `procedure-gate.test.ts`
> (4 tests) + 5 runtime seam tests in `create-worker.test.ts`.

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

## Phase 3 — Charge: paid MCP tools (`paidTool` port) — ✅ shipped (3a transport `84e4ae642`, 3b paidTool `3ffd7717c`)

> **Implemented.** The prereq (item 1) landed first: `@lunora/mcp` now serves
> over **remote Streamable HTTP** — `createMcpFetchHandler` + the shared
> `serveStateless` helper drive a stateless `WebStandardStreamableHTTPServerTransport`
> (`sessionIdGenerator: undefined`, `enableJsonResponse: true`), a Web-Standard
> `Request → Response` handler that runs on Workers/Node18+/Deno/Bun. Then the
> `paidTool` port (item 2): `createPaidMcpServer({ charge })` registers free
> `tool()` and priced `paidTool()` tools that coexist on one server (mirroring
> Cloudflare's `withX402(server, config)`). The gate (item 3 — the only new part)
> **reuses the Phase 1 charge middleware verbatim**: the fetch handler peeks the
> JSON-RPC body, and a `tools/call` naming a paid tool is wrapped in
> `createChargeMiddleware({ ...charge, price }, { resource: toolName })` at the
> HTTP boundary — unpaid → `402` + `PAYMENT-REQUIRED` (handler never runs);
> verified → dispatch, settle, `X-PAYMENT-RESPONSE`. Free tools and non-`call`
> methods dispatch without a paywall; a batch referencing a paid tool fails
> closed with `400` (one HTTP request carries one `X-PAYMENT`; MCP 2025-06-18
> removed batching anyway). `@lunora/mcp` gained a `@lunora/x402` dep (no cycle —
> x402 does not depend on mcp). Covered by `mcp/__tests__/http.test.ts` (3) +
> `mcp/__tests__/paid.test.ts` (6). The **STOP condition held**: the remote
> transport was real and committed before any paid tool.

**Prerequisite (now met).** `@lunora/mcp` was stdio-only; `paidTool` needs
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

## Phase 4 — Pay core + agent wallet (MVP-B) — ✅ EVM raw-key shipped (commit `8ed00cf2e`)

> **Implemented**: EVM raw-key custody is fully wired and tested —
> `resolveEvmAccount(secret)` (viem `privateKeyToAccount`) yields a
> `PrivateKeyAccount` that **structurally satisfies** `@x402/evm`'s
> `ClientEvmSigner` (no cast needed), registered via `registerExactEvmScheme`.
> `createX402Pay(config, deps)` → `{ fetch }` wraps the platform `fetch` with
> `wrapFetchWithPayment` (`@x402/fetch`). `deps.getSecret` is wired to
> `ctx.secrets.get` at the call site (wallet key is a **secret**).
>
> **SVM (Solana) raw-key pay custody now ships too** (follow-up, commit
> `aa196ae98`): `resolveSvmSigner(secret)` decodes a `ctx.secrets` Solana secret
> key — the `solana-keygen` JSON byte-array keyfile format **or** a base58 string
> — into a `@solana/kit` `KeyPairSigner` (a structural `ClientSvmSigner` /
> `TransactionSigner`), routing 64-byte secret keys to
> `createKeyPairSignerFromBytes` and 32-byte seeds to
> `createKeyPairSignerFromPrivateKeyBytes`, and registers the SVM exact scheme via
> `@x402/svm/exact/client`'s `registerExactSvmScheme`. `@solana/kit` (a peer of
> `@x402/svm`) is declared directly on `@lunora/x402`. Raw-key custody is now
> wired on **both** families; the pay rail is fully multi-chain.
>
> **User-supplied-signer escape hatch now ships** (follow-up, commit `3c9899afc`):
> a `{ type: "signer"; signer }` variant on `X402SignerConfig` lets a caller hand
> in a signer they built themselves — any `@x402/evm` `ClientEvmSigner` (a viem
> account: Turnkey, Privy, an AWS/GCP KMS `toAccount`, CDP's viem adapter, …) on an
> EVM network, or an `@x402/svm` `ClientSvmSigner` (a `@solana/kit`
> `TransactionSigner`) on Solana. `registerWallet` handles it first, before any
> `ctx.secrets` read, and guards the network family (`0x…` address vs base58) so a
> mismatch is a clear config error. This is the highest-leverage seam: it unlocks
> **every** custody provider via a structural adapter with **zero** per-provider
> SDK dependency in `@lunora/x402`.
>
> **First-party CDP-managed EVM custody now ships** (follow-up, commit `c204237dd`):
> the `{ type: "cdp" }` variant is wired on EVM via the optional `@coinbase/cdp-sdk`
> peer (optional peer + devDep + `catalog:web3` `1.51.2`, loaded lazily with
> `await import` so raw-key custody pulls neither Coinbase SDK). `resolveCdpEvmAccount`
> reads three CDP credentials from `ctx.secrets` (names default to the SDK's own
> `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` / `CDP_WALLET_SECRET`, overridable per
> config), constructs `CdpClient`, and `evm.getOrCreateAccount({ name })` — the
> account is **structurally a `ClientEvmSigner`** (it signs the x402 EIP-712
> authorization directly, so the key never leaves Coinbase), so no adapter is
> needed. The glue is covered by a mocked `@coinbase/cdp-sdk` (no live Coinbase
> call); the live path is **unverified in CI** (no CDP credentials in the sandbox).
>
> **Still deferred, failing loudly with `NOT_IMPLEMENTED` + guidance:**
> **CDP-managed custody on Solana** — a CDP Solana account is not a `@solana/kit`
> `TransactionSigner` (it signs via CDP-specific base64 methods), so wiring it needs
> a non-trivial, untestable kit-signer adapter. The error points at the `{ type:
"signer" }` escape hatch: build a `@solana/kit` signer around the CDP account and
> pass it there.
>
> **Three pluggable provider seams (matrix):**
>
> | Seam                            | Interface                                                    | Wired today                                                                                                                                      | Extend via                                                                                |
> | ------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
> | **Facilitator** (verify/settle) | `FacilitatorConfig { url, headers }`                         | public `x402.org/facilitator` default; self-hosted / CDP facilitator via `url` + auth `headers` (e.g. `@coinbase/x402`'s `createCdpAuthHeaders`) | any HTTP facilitator                                                                      |
> | **Wallet custody** (pay signer) | structural `ClientEvmSigner` (EVM) / `ClientSvmSigner` (SVM) | raw-key (EVM + SVM), CDP-managed (EVM), user-supplied signer (both)                                                                              | the `{ type: "signer" }` escape hatch — Turnkey, Privy, Fireblocks, KMS, CDP-on-Solana, … |
> | **Scheme / chain**              | `@x402/evm` + `@x402/svm` exact schemes                      | EVM (`eip155:*`) + Solana                                                                                                                        | future `@x402/*` scheme packages                                                          |
>
> **Plan correction (2026-07-04, still stands):** `@coinbase/x402` is **not** a
> wallet/signer provider — v2.1.0 is a _facilitator-auth_ helper. CDP **wallet**
> custody is `@coinbase/cdp-sdk` (now wired for EVM). `wrapClient` (the MCP-client
> payer) remains deferred — it belongs with Phase 3's remote MCP transport.

1. **`pay/wallet.ts`** — resolve a signer: `privateKeyToAccount(secret)` (viem,
   EVM) or `resolveSvmSigner(secret)` (`@solana/kit`, SVM) where `secret` comes
   from `ctx.secrets.get(name)`; CDP-managed EVM account via `@coinbase/cdp-sdk`
   (optional peer, **wired**); or a user-supplied `{ type: "signer" }`. Wallet
   lives on **`ActionCtx` only** (crypto + outbound network → action-only, same
   as `ctx.browser`/`ctx.sql`).
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

## Phase 5 — Pay: policy (confirmation + spend caps) — SECURITY-CRITICAL — ✅ shipped (commit `8ed00cf2e`)

> **Implemented** in `pay/policy.ts`, fully unit-tested, mapped onto
> `@x402/core`'s three client seams:
>
> - `buildSpendPolicy(policy)` → a **`PaymentPolicy`** (runs at selection):
>   filters offered requirements to those within the per-call cap and on the
>   recipient / network allowlists. Empty result ⇒ the client has nothing to sign
>   ⇒ **cannot pay** (fail-closed).
> - `buildPaymentGuard(policy, state)` → a **`BeforePaymentCreationHook`**: the
>   stateful per-run cumulative cap **and** the async confirmation gate
>   (`onPaymentRequired`), aborting before any signature.
> - `recordSpend(state)` → an **`AfterPaymentCreationHook`** tracking cumulative
>   spend the guard reads.
> - `assertBoundedPolicy(policy)` runs **first** in `createPayFetch`, _before_ a
>   signer is resolved — an unbounded policy (`{}`) throws `FORBIDDEN`. The pay
>   rail is fail-closed **by construction**: `X402PayConfig.policy` is required.
> - `usdToAtomic` parses digit-by-digit (no binary-float drift), rejects
>   exponential/negative; refusals surface as typed `LunoraError` codes.
>
> Advisor lint (item 4) — **obviated, not built** (follow-up review 2026-07-10).
> The lint was scoped to flag an unbounded/`null` spend policy, but Phase 5 made
> `X402PayConfig.policy` a **required, non-nullable** field: a missing or `null`
> policy is now a **compile error**, and `assertBoundedPolicy` throws `FORBIDDEN`
> at runtime before a signer is resolved. On top of that the pay config lives in
> the app's `createShardDO({ x402: (env) => ({ policy }) })` thunk — outside any
> procedure body — so the procedure-middleware advisor feeder
> (`discover-procedure-middleware` → `ctx.procedureProtections`) is the wrong seam
> to catch it. The type system + the runtime guard already fail closed, so a
> static lint would be redundant. Not planned.

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

## Phase 6 — Reporting bridge into `@lunora/payment` (optional) — ✅ shipped (commit `34b29c24`)

1. **`receipt.ts`** — normalize each settlement into a
   `{ network, tx, from, to, amount, resource, ts }` receipt.
2. Optional sink: forward receipts to `@lunora/payment`'s **observability**
   (`PaymentObserver`) and/or a durable table, so x402 revenue/spend shows up
   next to Stripe/Polar in **Studio** — **without** coupling the rails (x402 is
   not a `PaymentAdapter`). Keep it a one-way, opt-in bridge.

> **Implemented.** `charge/receipt.ts` normalizes each settlement into a stable
> `X402Receipt` (atomic USDC `amount` kept as an exact string — never coerced to
> a fractional-dollar number; prefers the actually-settled amount, falls back to
> the route requirement). An opt-in `config.onReceipt` sink is fired from the
> charge middleware after settlement — **best-effort** (not awaited; sync throws
> and async rejections both swallowed) so a reporting failure never withholds a
> paid resource — and rides on `X402ChargeConfig`, so it flows to the HTTP-action
> rail and the per-procedure gate for free. `toPaymentEventRow` is a **zero-import**
> bridge that shapes a receipt as a `@lunora/payment` `events` row (unique on the
> tx hash) so it renders in Studio's Payments panel with no Studio change.
>
> **Ruling on the observer path:** the typed `PaymentObserver` seam was rejected
> deliberately. It is an _outbound_ alert callback with **no settlement/success
> event** and a **closed `ProviderId` union** (no `"x402"`), so it cannot carry a
> receipt. The durable-table path stays fully decoupled because `@lunora/payment`'s
> `provider` columns are plain `v.string()` — a `provider: "x402"` row persists
> and renders fine. Amounts don't render in the Payments panel today (it shows
> `provider`/`type`/`providerEventId`/`processedAt`); surfacing USDC amounts would
> need a Studio panel change + a revenue table (deferred, out of this plan's scope).

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
  managed vs bring-your-own signer? **RESOLVED (all three shipped)**: raw-key on
  both families, CDP-managed EVM via the optional `@coinbase/cdp-sdk` peer
  (`c204237dd`; note custody is `@coinbase/cdp-sdk`, not the facilitator-auth
  `@coinbase/x402`), and a `{ type: "signer" }` escape hatch (`3c9899afc`) for any
  provider-built signer. CDP on Solana stays deferred (not a `@solana/kit` signer).
- **`category:web3`** new project.json tag vs reuse `category:payment`?
