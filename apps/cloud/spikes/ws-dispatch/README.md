# Spike: WebSockets + dispatch (CLOUD-PLAN.md §6 risk #3)

**Question.** Cirrus's hottest path is the hibernated-WebSocket subscription
(`/_cirrus/ws` → `forwardToShard` → `ShardDO.acceptWebSocket`). The least-
documented Workers-for-Platforms case is whether that path — and per-invocation
CPU limits — behave correctly when the upgrade traverses
`env.DISPATCHER.get(script).fetch(request)`. This spike validates it on real
Cloudflare before we build the rest of the cloud on the assumption that it works.

## Hypotheses to validate

1. **Upgrade survives dispatch.** A `GET /_cirrus/ws` upgrade routed through the
   dispatcher returns `101 Switching Protocols` with a live `webSocket`, and the
   socket stays open eyeball↔tenant.
2. **Hibernated delivery survives dispatch.** After the DO hibernates, an inbound
   frame still wakes `webSocketMessage`, and a **server-initiated push**
   (a broadcast triggered by an HTTP request — the "mutation → subscription"
   shape) is delivered to the connected socket.
3. **Per-invocation limits behave.** The dispatcher's `{ limits: { cpuMs } }`
   applies to dispatched invocations without silently killing the WS connection,
   and CPU-heavy message/HTTP handlers are bounded per invocation (not per
   connection) — so a hibernatable socket gets a fresh CPU budget per frame.

## What's in here

| File                    | Role                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `tenant-worker.ts`      | A framework-free hibernatable-WS Durable Object (the exact primitive `ShardDO` uses), + routes.    |
| `tenant.wrangler.jsonc` | Deploys the tenant **into** the dispatch namespace.                                                |
| `probe.mjs`             | Node 22 probe (zero deps) that drives the tenant **through the dispatcher** and reports PASS/FAIL. |

The dispatcher's side of the contract — that it forwards the upgrade and returns
the `101`+`webSocket` response unchanged — is unit-pinned in
`apps/cloud/__tests__/dispatcher-ws.test.ts` (runs in CI, no infra needed). This
harness validates the half that only a live dispatch namespace can prove.

## Run it (needs a Cloudflare account + the Workers-for-Platforms add-on)

```bash
cd apps/cloud/spikes/ws-dispatch

# 1. Create the dispatch namespace once (if not already):
wrangler dispatch-namespace create cirrus-production

# 2. Deploy this tenant INTO the namespace as script "ws-spike":
wrangler deploy -c tenant.wrangler.jsonc \
  --dispatch-namespace cirrus-production --name ws-spike

# 3. Deploy the cloud dispatcher (from apps/cloud), pointed at the same
#    namespace + your zone (see ../../dispatcher.wrangler.jsonc):
( cd ../.. && wrangler deploy -c dispatcher.wrangler.jsonc )

# 4. Probe it through the dispatcher (use your CIRRUS_APP_DOMAIN):
node probe.mjs https://ws-spike.cirrus.app
```

To force hibernation between steps, pause ~30s after the socket opens before
running the broadcast — an idle hibernatable DO is evicted, so the push then
exercises the cold-wake path.

## Pass / fail

- **PASS** when the probe prints `3/3 hard checks passed`:
  `websocket upgrade through dispatch`, `hibernated webSocketMessage echo`, and
  `server push through dispatch` all PASS.
- The **cpuMs probe** is informational: with the free-tier cap (`cpuMs: 50`,
  from `src/billing/plans.ts`) `/burn?ms=` calls above ~50ms should start
  returning a `1102`/exceeded error or a 5xx, while small burns succeed — and
  crucially the **WebSocket stays open** throughout (a per-invocation limit must
  not tear down the connection).

## Expected results & caveats (reason from the docs; the spike confirms)

- WfP dispatch-namespace Workers support WebSockets, and a subrequest WS upgrade
  (`stub.fetch(upgradeRequest)` → `101` + `webSocket`) is the documented way to
  proxy one; returning that response verbatim is expected to pass it through.
- DO **hibernation** (`acceptWebSocket` + `webSocketMessage`) is unaffected by
  WfP — the DO lives in the tenant script, dispatched like any other. The open
  risk is purely the **dispatcher→tenant** hop, which this probe exercises.
- **Custom limits are per invocation.** A hibernatable socket's per-frame wake is
  a fresh invocation with its own `cpuMs`, which is the behaviour we want; the
  risk to confirm is that hitting the cap kills only that frame's handler, not
  the socket. If the spike shows otherwise, raise the floor in `limitsForPlan`
  for plans that rely on heavy per-message work, or move such work to an action.
- **Metering note:** the dispatcher counts the upgrade as one request; per-frame
  invocations run inside the DO and are not re-counted at the dispatcher (see
  `src/dispatcher/worker.ts`). Confirm whether per-frame CPU should be metered
  via the DO/AE path if message volume matters for billing.

Record the observed outcome (and any limit threshold) back in `CLOUD-PLAN.md`
§6 risk #3 once run.
