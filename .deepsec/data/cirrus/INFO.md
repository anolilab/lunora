# cirrus

## What this codebase does

Cirrus is a pnpm monorepo (`@cirrus/*`) for a Convex-style, type-safe
real-time backend that compiles TypeScript queries/mutations/actions
into Cloudflare Workers backed by Durable Objects (state), D1 (SQL),
R2 (blobs), and Queues. It runs on the _user's own_ Cloudflare account
— no proprietary server. Default topology is one DO per app; `.shardBy()`
partitions state per tenant/user/room and `.global()` replicates reads.
This is library/framework code, so most "users" are app developers; the
threat surface is what the framework exposes to _their_ end users.

## Auth shape

- `resolveIdentity(request, env)` on `createWorker` is the identity
  boundary — turns a request into `ResolvedIdentity | null`. Everything
  downstream trusts its result.
- `@cirrus/auth` wraps better-auth (cookie sessions, PBKDF2 email/pw,
  OAuth PKCE). `handleAuthRequest` routes `/api/auth/*`; `withAuthPlugins(auth)`
  mounts the plugin surface as `ctx.authApi`.
- `ctx.auth` is identity-only (`userId`, `getIdentity()`); `ctx.authApi`
  is the full privileged better-auth API. Don't conflate them.
- RLS: `definePolicy` / `definePolicies` / `defineRole` + the `rls()`
  middleware. Read policies OR together; write policies for a `(table, op)`
  AND together (every one must allow).
- Admin export/import endpoints are gated by an admin bearer token
  (`ADMIN_FORBIDDEN` 403). The token is also accepted via `?token=` query
  param because DO subrequests can't set `Authorization`.

## Threat model

Top risk is **cross-tenant data access via shard routing**: `envelope.shardKey`
and `envelope.fanOut` are read straight from the request body, and a
fan-out dispatches the caller's `functionPath` (queries _and_ mutations)
to every live shard. An authenticated tenant could otherwise read/mutate
every other tenant's data. Secondary: admin export/import exposes full DO
state; signed-URL secrets gate R2 blobs; codegen emits into the user's repo.

## Project-specific patterns to flag

- Routing on `envelope.shardKey` / `envelope.fanOut` / `functionPath`
  WITHOUT passing through `authorizeShard(identity, shardKey)` /
  `authorizeFanOut(identity, table, functionPath)`. Fan-out must be
  default-deny when `authorizeShard` is set but `authorizeFanOut` is not.
- New RPC/admin routes that skip the admin-bearer 403 gate, or that widen
  the `?token=` query-param channel beyond admin export/import.
- Signed URLs (`packages/storage`): HMAC canonical must bind the URL host;
  the signing secret must not be shared across buckets/tenants; verify must
  NOT leak `expired` vs `bad_signature` to clients (signing oracle).
- Codegen emit (`packages/codegen`): identifier / literal / import-path
  slots must be validated/escaped before interpolation, and non-identifier
  field names must be rejected or quoted — else code injection into `_generated/`.
- Destructive CLI ops must be gated: `reset` and `migrate --prod` require
  `--yes`/TTY; `init` rejects unsafe `--source` without `--allow-unsafe-source`;
  the Vite studio plugin must refuse to serve off-loopback.

## Known false-positives

- `apps/` examples, `templates/`, and `.vis/templates/cirrus-*.ts` are
  scaffolding/fixtures — not production attack surface.
- The Vite studio plugin and `cirrus dev` server are dev-only and
  loopback-bound; localhost binding there is intentional.
- Admin export accepting `?token=` is deliberate (DO subrequests can't set
  the `Authorization` header), not a token-in-URL leak.
- `VERSION = "0.0.0"` and similar placeholders in package indexes.
- workerd-dependent tests / example dev servers can't run in some sandboxes
  (connect timeouts) — a missing runtime is environmental, not a vuln.
