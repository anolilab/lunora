# Plan 309 — MCP exposes the observability reads an agent needs to debug

**Baseline:** `370994075` (2026-08-08)
**Status:** DONE — `feat/plan-309-mcp-observability`

## 0. Headline finding

The MCP server exposes **six** tools (`packages/mcp/src/tools.ts:39-89`):
`list_functions`, `list_tables`, `get_function_schema`, `run_query`, and — only
behind `allowWrites` — `run_mutation`, `run_action`. An agent can therefore
_call_ a deployment but cannot _see what happened_: no logs, no grouped issues,
no advisor findings, no query insights, no migration status. Every one of those
already exists as an admin RPC (`packages/shard-engine/src/introspect.ts:50` —
`getLogs`, `getIssues`, `getTraces`, `getAdvisories`, `getQueryInsights`,
`getFunctionStats`, `migrationStatus`, …) and already backs the Studio and the
`lunora logs` / `insights` / `advisor` commands. The data is built; only the
MCP surface over it is missing.

Second finding, smaller and mechanical: every tool returns
`{ content: [{ type: "text", text }] }` (`tool-types.ts:47-50`). There is no
`outputSchema` on `ToolDefinition` and no `structuredContent` on the result, so
a client receives JSON stringified inside a text block and must re-parse it
without a schema to validate against.

## 1. Current state (audit)

- **Tool surface** (`packages/mcp/src/tools.ts`): four read-only definitions
  (`:39-64`), two write definitions (`:68-89`), gated by `allowWrites` in
  `toolDefinitions()` (`:96+`) and re-checked at dispatch
  (`server.ts:142-164`). The gate is sound and fails closed — this plan does not
  touch it.
- **Result shape** (`tool-types.ts:47-50`): `ToolResult` is
  `{ content: { text, type: "text" }[]; isError?: boolean }`. `ToolDefinition`
  (`:41-46`) carries `annotations`, `description`, `inputSchema`, `name` — no
  `outputSchema`.
- **Transport/auth** (`packages/cli/src/commands/mcp/index.ts:42-46`): `serve`
  takes `--allow-writes`, `--url` (defaults to the running dev server), and
  `--token` (defaults to `LUNORA_ADMIN_TOKEN` from the environment or
  `.dev.vars`). So an admin bearer token is already resolved and in hand.
- **How the CLI reaches admin RPC today**: by hardcoding the op string per
  command — `const GET_FUNCTION_STATS_OP = "__lunora_admin__:getFunctionStats"`
  (`packages/cli/src/commands/insights/handler.ts:10`), with the bearer token
  attached at the call site. There is no shared admin-RPC client; each consumer
  re-derives the path and the fetch.
- **`@lunora/client`** exposes no admin surface (`grep admin packages/client/src/index.ts`
  is empty), so the MCP server's existing `LunoraClient` dependency cannot reach
  these reads as-is.

    > **Correction (execution).** This is wrong, and it is what §5's "shared admin
    > caller" workstream was sized around. The `__lunora_admin__:*` ops are not a
    > separate endpoint: they ride the ordinary `POST /_lunora/rpc` envelope
    > (`{ args, functionPath, shardKey }`) and the shard intercepts them before
    > user dispatch — which is exactly what `LunoraClient.rpc` sends, and what the
    > studio already does through `useAdminQuery`. So `client.query({ __lunoraRef:
ADMIN_FUNCTIONS.getLogs }, args, { shardKey })` reaches every one of these
    > reads today, with the bearer, the `{ error }` envelope and the response
    > decode all being the client's existing behaviour. No new caller module was
    > written; `adminRead` in `observability-tools.ts` is a three-line wrapper over
    > `client.query`.

## 2. Existing seams (do not reinvent)

- **`ADMIN_FUNCTIONS`** (`packages/shard-engine/src/introspect.ts:50`) — the
  canonical op-path table. Import it; never re-type `"__lunora_admin__:…"`
  string literals (the CLI's copies are the anti-pattern, not the model).
- **`toolDefinitions(allowWrites)` + the dispatch switch** (`tools.ts`,
  `server.ts:142-164`) — the existing two-tier gate. Observability tools join it
  as a third tier, they do not fork it.
- **`READ_ONLY_ANNOTATIONS`** (`tools.ts:36`) — reuse verbatim.
- **`packages/observability/src/*`** — the read models behind the admin RPCs
  (`request-log.ts`, `issue-state.ts`, `query-metrics.ts`, `function-metrics.ts`).
  Tools shape their output; they do not re-aggregate.
- **`@lunora/advisor`'s finding shape** — for the advisories tool.
- **`packages/mcp/src/docs`** — the documentation tool surface already shows how
  a second tool family composes into this server without touching the first.

## 3. The behavioural contract to preserve

- `allowWrites: false` (the default) keeps every write tool **out of
  `ListTools`**, not merely refused at dispatch (`server.ts:104`). Adding tools
  must not change which names appear at each tier.
- Existing tool names, input schemas, and text-content output stay unchanged.
  `structuredContent` is **additive** — clients that read `content[0].text`
  today keep working, because the text block is still emitted.
- The server stays usable with no admin token (dev-server default), which means
  the new tools must degrade rather than crash the whole server.

## 4. Design decisions

- **A third tier: read-only-but-privileged.** Observability tools are read-only
  in the `readOnlyHint` sense, but they surface production logs, request
  payload metadata, and grouped errors. They are exposed **only when an admin
  token resolved**, and omitted from `ListTools` otherwise — the same
  omit-don't-refuse rule the write gate already uses. Chosen over folding them
  into the always-on read tier (leaks the existence of privileged data on an
  unauthenticated server) and over putting them behind `--allow-writes`
  (conflates "may change data" with "may read operational data").
- **Import `ADMIN_FUNCTIONS`; do not copy op strings.** Chosen over the CLI's
  existing hardcoded-literal pattern, which is how a renamed op ships a 404 to
  one consumer and not another.
- **A small shared admin-RPC caller inside `@lunora/mcp`, not a new public
  surface on `@lunora/client`.** Chosen because widening the browser client with
  admin RPC would put a privileged path into every app bundle. If a second
  non-CLI consumer appears, promote it then — not now.
- **`outputSchema` + `structuredContent`, text block retained.** Chosen over
  replacing the text content (breaks existing clients) and over structured-only
  for new tools (two result conventions in one server is worse than one
  slightly redundant one).
- **Scope: logs, issues, advisories, insights, migration status.** These are the
  five an agent actually needs to answer "did my change work, and what broke".
  Traces, metric history, subscriptions, queue/workflow inspection are
  deliberately deferred — each is a bigger output shape, and an unused tool is
  context an agent pays for on every turn.
- **Every tool takes a bounded `limit` with a server-side clamp**, mirroring
  `lunora logs --limit` (clamped 1–10000). An unbounded log read is how an agent
  burns its whole context on one call.

## 5. Workstreams

**S — shared admin caller.** One module in `@lunora/mcp` that takes
`{ url, token }` and an `ADMIN_FUNCTIONS` key, POSTs the RPC, and returns the
parsed result or a `LunoraError`. Reused by all five tools.

**Done.** — as a three-line wrapper, not a module (see the §1 correction).
`adminRead(client, op, args, shardKey)` in `packages/mcp/src/observability-tools.ts`
calls `client.query`, so the bearer, the error envelope and the wire decode are
the client's, not a second implementation. `@lunora/shard-engine` is now a
dependency of `@lunora/mcp` so `ADMIN_FUNCTIONS` is imported rather than copied
(the cost: `@lunora/errors` + `@lunora/platform` + `drizzle-orm` join the MCP
install tree; the alternative — studio's deliberate copy of the table — is the
drift the plan set out to avoid).

**M — the five tools.** `lunora_get_logs`, `lunora_get_issues`,
`lunora_get_advisories`, `lunora_get_query_insights`,
`lunora_get_migration_status`. Each: a narrow input schema (`limit`, plus the
filters its RPC already supports — level/function-prefix for logs, status for
issues), `READ_ONLY_ANNOTATIONS` with a real `title`, and a description that
tells the agent _when_ to call it, not just what it returns.

**Done.** — with three deviations worth the record:

1. **`getLogs` takes no arguments.** It returns the whole in-memory ring
   (≤500 entries), so `limit`/`level` are applied in the tool. `getIssues` does
   accept `limit`/`status`/`functionPathPrefix`, so those are pushed down to the
   RPC — grouping has to happen over the right row set, not over a page the tool
   already truncated.
2. **The clamp is 1–500, not 1–10000.** The binding constraint here is the
   model's context window (every row is re-read on every subsequent turn), not
   the datastore's. Default 50.
3. **`lunora_get_migration_status` takes no `limit`.** Its list is one row per
   declared migration, and dropping the tail would hide exactly the pending
   migration the caller is asking about.

**S — token-tier gating.** `toolDefinitions` learns a third argument (or the
options object grows a resolved-token flag); tools are omitted from `ListTools`
and refused at dispatch when no token resolved. Test both halves — the omission
and the refusal — since the write gate's own tests establish that pattern.

**Done.** `toolDefinitions(allowWrites, hasAdminToken)` and
`callTool(client, name, input, allowWrites, hasAdminToken)`. `server.ts` derives
the flag from `options.token` (an injected `client` carries no token this server
knows about, and the fail-closed reading of "unknown" is "no privileged tools").

`local.ts` — the surface `lunora mcp serve` actually mounts — needed a decision
the plan did not anticipate: its deployment is a **resolver** called per tool
call, so no token is known when the list is built. The advertised list therefore
uses a **snapshot** taken at build time (fail-closed: an editor that spawned the
server before `lunora dev` does not see the observability tools that session),
while dispatch re-checks the freshly resolved token. Both halves are tested,
including the withdrawn-token case where a listed tool is still refused.

**M — structured output.** Add `outputSchema?: ToolInputSchema` to
`ToolDefinition` and `structuredContent?: unknown` to `ToolResult`
(`tool-types.ts`); populate both for the five new tools; leave the six existing
tools text-only for now (a follow-up can schema them once the shape proves out).

**Done.** — with one type correction: `structuredContent` is
`Record<string, unknown>`, not `unknown`. The MCP schema is
`z.record(z.string(), z.unknown())` — a bare array is invalid there, so the type
has to say so, or a tool returning one would only fail at the wire.

The sharper part is serialization, and it is the plan-300 STOP condition in
disguise: `structuredContent` is serialized by the **transport**, so an unmapped
`bigint` in it throws at the protocol layer and takes the whole response down
rather than one field. `toJsonSafe` (in the new
`packages/mcp/src/tool-result.ts`) runs it through the same bigint→string /
bytes→base64 replacer the text block already used. Pinned by a test that logs a
`bigint` and a `Uint8Array` through a log entry's `fields`.

**S — docs + CLI help.** `mcp serve`'s help text says which tools require a
token. The MCP package docs gain the tool table.

**Done.** `--token`'s description in `packages/cli/src/commands/mcp/index.ts`
now says it gates the observability tools, plus an example line;
`packages/mcp/README.md` gains the five rows and a "privileged" section stating
plainly what they expose (log lines and error messages reaching the model's
provider) and that they are independent of `--allow-writes`.

## 6. Platform parity

Not applicable to the `ctx.*` matrix — this plan adds no runtime surface and no
provider binding. It reads existing admin RPCs, which are served by whichever
host mounts the shard engine; nothing here is Cloudflare-specific, so no
capability row changes.

## 7. Phasing & ordering

| Phase | Work                               | Gate                                                                                                                 |
| ----- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 0     | Shared admin caller                | Unit test against a mock fetch: op path comes from `ADMIN_FUNCTIONS`, bearer header set, error maps to `LunoraError` |
| 1     | Token-tier gating                  | Two tests: no token → the five names absent from `ListTools`; token → present. Dispatch refuses when absent          |
| 2     | The five tools                     | Per-tool test against a mock admin response, including the `limit` clamp at both bounds                              |
| 3     | `outputSchema`/`structuredContent` | Test: a new tool's result validates against its own declared `outputSchema`, and `content[0].text` is still present  |
| 4     | Docs                               | `pnpm run lint:prettier` clean; `pnpm run api:check` (or `api:update` after a fresh build) for the widened types     |

## 8. Risks & STOP conditions

- **STOP** on the admin-RPC wire encoding before shaping any output. The admin
  RPC path does **not** run results through `encodeWire` while the client still
  decodes — see the `admin-rpc-does-not-encodewire` finding and plan **300**
  (`plans/300-decode-doc-read-paths.md`). A tool that decodes an admin result
  for display will 500 on any row carrying a `bigint` or `ArrayBuffer`. Read 300
  first and follow whatever convention it lands; do not invent a third one here.

    **Resolved — the convention was followed, not reinvented.** Plan 300 landed on
    this: the client decodes EVERY response (`rpc()` ends in
    `decodeWire(body.result)`), so a server-side decode is both wrong (it makes
    `jsonResponse`'s `JSON.stringify` throw on a bigint → a redacted 500) and
    unnecessary. 300's S1 was reverted for exactly that, and `shard-engine`'s
    introspect test now pins it. These tools sit on the **client** side of that
    boundary, so they receive already-decoded values — real `bigint`/`ArrayBuffer`
    — and the correct handling is the one `tools.ts` already had: map them at the
    JSON boundary rather than decode or re-encode anything. Nothing here decodes an
    admin result, and nothing hands one to `decodeWire` a second time.

- **Risk:** log/issue payloads carry user data straight into an agent's context
  (and thus into a model provider). Mitigate: the token tier is the control, and
  the docs must say plainly what these tools expose. If field-level redaction is
  wanted, that is its own plan — do not half-redact here.
- **Risk:** five more always-listed tools crowd the agent's tool budget.
  Mitigate: keep the scope at five, and keep descriptions one sentence.
- **Risk:** `ToolDefinition`/`ToolResult` are exported types; widening them is
  an API-surface change. Mitigate: both new fields are optional, and
  `api:update` runs after a fresh build (a stale `dist/` writes a wrong snapshot).

## 9. Open questions (answered during execution)

1. Which MCP protocol revision does the server advertise, and does it match the
   one that introduced `structuredContent`/`outputSchema`? If not, bump the
   advertised version in the same change or the field is ignored.
2. Do the admin reads accept a shard key, and should the tools expose it? A
   sharded deployment's logs are per-shard; a tool that silently reads one shard
   would be misleading.
3. Is `getRequestLog` (single request detail) worth a sixth tool, paired with
   `getLogs` for drill-down?
4. Should `lunora_get_advisories` reuse the `lunora advisor` CLI's severity
   filtering, or return everything and let the agent filter?
5. Does the hosted/stateless server (`serve-stateless.ts`, `paid.ts`) resolve an
   admin token the same way, or does the token tier need a different rule there?

### Answers

1. **No revision is advertised by us, and none needs bumping.** `server.ts`
   passes only `{ name, version }` (an `Implementation`, not a protocol
   revision); the SDK's `Server` negotiates the protocol itself. At
   `@modelcontextprotocol/sdk` 1.29.0 that is `SUPPORTED_PROTOCOL_VERSIONS =
["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"]`, and
   `structuredContent` / `outputSchema` arrived in **2025-06-18** — inside the
   supported set, and both are first-class fields on the SDK's `ToolSchema` /
   `CallToolResultSchema`, so they survive rather than being stripped as unknown
   keys. A client that negotiates `2025-03-26` (also the SDK's
   `DEFAULT_NEGOTIATED_PROTOCOL_VERSION` when a client asks for something
   unknown) simply ignores both fields — which is the whole reason the text block
   is still emitted. Server-level tests assert `outputSchema` survives
   `ListTools` and `structuredContent` survives a `CallTool` round trip.
2. **Yes, and they expose it.** Every one of these reads is served by the shard
   that handled the traffic — the studio passes `shardKey` to exactly these RPCs
   — so on a `.shardBy()` deployment "the logs" are per-shard. All five tools
   take an optional `shardKey`, and its description says the reads are per-shard
   rather than deployment-wide, because silently reading the default shard and
   presenting it as the deployment is the misleading outcome the question names.
3. **Not now.** `getIssues` already carries the sample message and the grouping
   hash, which is the drill-down an agent acts on; a sixth tool costs context on
   every turn for a detail view that mainly pays off in a UI. Left deferred with
   traces/metrics, per §4's scope decision.
4. **Return everything (bounded by `limit`), no severity filter.** The advisory
   set is small and each finding already carries its `level`, so the agent can
   filter what it has; a severity knob would be a second filtering vocabulary to
   keep in sync with the CLI's, for no new capability.
5. **Same rule, and it lands correctly by construction.** `serve-stateless.ts`
   is a transport helper with no token resolution, and `paid.ts` composes tools
   rather than building the deployment server, so both reach the gate through
   `createLunoraMcpServer` / `callTool`. A hosted server started without a
   `token` option therefore advertises no observability tools and refuses them at
   dispatch — the fail-closed default, which is the right one for the surface
   most likely to be public.
