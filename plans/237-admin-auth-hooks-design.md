# Plan 237 — Reactive admin/organization auth hooks (design spike)

- **Category**: DX / adapter parity
- **Priority**: P2
- **Effort**: M (design) + S (this spike's React prototype)
- **Status**: SPIKE — design doc + one-adapter prototype only, per plan 237's scope
- **Base**: `advisor/217-client-lifecycle` @ `b019d4181`
- **Goal**: decide how `LunoraClient`'s ~35 imperative auth-admin methods
  (`listAuthUsers`, `createAuthOrganization`, `impersonateAuthUser`, …) should
  surface as adapter hooks, and prove the contract with a React prototype
  before committing to a five-adapter build.

## Context (verified against this branch)

`packages/client/src/lunora-client.ts` (~line 2871 onward, "Auth admin"
section) carries the full surface: user CRUD + ban/role/password, passkeys,
linked accounts, two-factor, organizations + members + invitations + teams +
custom roles, sessions, and capability/config introspection. Every one of
these routes through a single private method:

```ts
// lunora-client.ts:4119
private async adminFetch(path, method, payload?, contentType?): Promise<unknown> {
    …
    const response = await this.fetchImpl(joinUrl(this.url, path), { body, headers, method });
    …
}
```

`adminFetch` is a **plain `fetch()` call**. It shares nothing with the
client's live transport — no `ensureSocket`, no `sendOn`, no
`shapeSubscriptions`, no `subscribe()`. The WS/live machinery lives in a
completely separate part of the same file (`ensureSocket`, `sendConnectEnvelope`,
`resendShapeSubscriptions`, starting ~line 4256). This is the first piece of
evidence for the live-vs-one-shot question below: structurally, these ~35
methods cannot ride the live transport — they never touch a socket.

`@lunora/react` has no hooks over any of this. `useQuery`/`useMutation`
(`packages/react/src/use-query.ts`, `use-mutation.ts`) are generic over
`FunctionReference` — a Lunora-generated `query`/`mutation`/`action` with a
`__lunoraRef`. The auth-admin methods are bespoke class methods, not
`FunctionReference`s, so neither hook can wrap them as-is.

`@lunora/studio` (`packages/studio/src/features/auth/*`) already hand-rolls
every one of these methods into panels — the reference implementation this
spike lifts a contract from.

## Live vs one-shot — CONFIRMED: one-shot, explicit refetch

The plan predicted this ("admin-gated RPCs, deliberately excluded from the
batch/live transport") and Studio's own code confirms it in three independent
places:

1. **The client-side split.** `packages/studio/src/hooks/use-admin-query.ts`
   defines _two_ primitives:
    - `useClientQuery` (line 131) — "the base primitive for the studio's
      **non-admin-RPC reads** (the bespoke `client.listAuthUsers()` /
      `client.schedulerStatus()` / … methods that aren't routed as
      `__lunora_admin__:*` paths) … **No live bridge — these backends are
      HTTP-only and the panels poll via `useAutoRefresh`.**"
    - `useAdminQuery` (line 182) — for **reserved admin RPC paths**
      (`__lunora_admin__:listTables`, etc.) that the runtime intercepts
      _inside the Durable Object_ and that DO support an optional `live: true`
      WS subscription (`client.subscribe`).

    These are two different admin surfaces that happen to share the word
    "admin": one is a reserved RPC namespace dispatched through the DO's normal
    query/subscribe path; the other — the auth-admin methods this plan is
    about — is a separate HTTP-only route tree (`/_lunora/admin/auth/*`) with
    no subscribe counterpart at all. Every panel this plan's reference code
    touches (`organizations-panel.tsx`, `users-panel.tsx`,
    `auth-sessions-panel.tsx`) uses `useClientQuery`, never `useAdminQuery`.

2. **Explicit code comments at every call site.** `organizations-panel.tsx:39`:
   _"The org/auth store is HTTP-only (no admin-RPC path), so this is a
   `useClientQuery` read over the bespoke `client.listAuthOrganizations`."_
   `users-panel.tsx:50` and `auth-sessions-panel.tsx:28` carry the identical
   comment verbatim.

3. **Polling stands in for "live."** `packages/studio/src/hooks/use-auto-refresh.ts`
   exists specifically because these backends have "no live subscription
   channel" (its own docstring) — every one of the three auth panels wires
   `useAutoRefresh(() => query.refetch(), …)` on a 5s interval, paused when the
   tab is hidden. Mutations refetch explicitly and immediately in addition
   (e.g. `organizations-panel.tsx:171-188`, `dialog onDone={refetchOrgs}`).

**Conclusion**: the hook layer is `useQuery`-from-TanStack-Query-flavored (a
fetch + cache + refetch), not `useQuery`-from-`@lunora/react`-flavored (a live
WS subscription). No design alternative was live-capable given the transport
split above — this wasn't a close call once `adminFetch` was read.

### A naming trap this ruled out

`@lunora/react` already exports a `useClientQuery` (`packages/react/src/use-client-query.ts`)
— a **completely unrelated** primitive: a local reactive atom
(`createClientQuery`/`subscribeClientQuery`) that never touches the network.
Studio's `useClientQuery` (TanStack-backed HTTP read) and `@lunora/react`'s
`useClientQuery` (local atom) are false cognates. The prototype hooks in this
spike do **not** reuse that name for anything, and a real cross-adapter build
should pick a name that doesn't collide with it (e.g. the `useAdminAuth*`
prefix used here, or `useAuthAdminQuery`).

## Hook contract

Every list hook returns the same shape (TanStack-Query-backed, one-shot +
explicit refetch, matching the plan's requested `data`/`loading`/`error`/
`loadMore`/`refetch`):

```ts
interface AdminAuthListResult<T> {
    data: T[] | undefined; // rows so far; undefined before the first response
    total: number | undefined; // AuthPage.total — undefined before the first response
    loading: boolean; // true only before any data has resolved
    error: Error | undefined;
    hasMore: boolean; // total !== undefined && data.length < total
    loadMore: () => void; // grow the requested window and refetch
    refetch: () => void; // re-run the read (e.g. after an external mutation)
}
```

**Pagination model**: `AuthPage<T>` (`packages/runtime/src/auth-admin-routes.ts:38`)
is `{ rows: T[]; total: number }` — offset/limit, not cursor-based (unlike
Convex-parity `usePaginatedQuery`'s stable-boundary cursor pages). Studio
itself doesn't paginate past the first page today (`users-panel.tsx` requests
a flat `limit: 50` and never grows it). The prototype's `loadMore` is
therefore a genuine ergonomic addition, implemented as a **growing window**
rather than a page-accumulator: `loadMore` bumps a `limit` state value and
the query re-fetches `{ limit }` from the top each time. This sidesteps the
page-boundary/rebalancing machinery `use-paginated-core.ts` needs for live
cursor pagination (irrelevant here — there's no live delta stream to keep
boundaries stable against) and keeps the whole hook effect-free: `loadMore`
is a plain state setter in a callback, not a `useEffect` merging arrivals.
Trade-off: `loadMore` re-fetches the whole window instead of appending one
page — acceptable for admin-dashboard cardinalities, called out as an open
question for the real build (see below) if a target's user/session counts
get large.

**Mutation ergonomics**: mirroring Studio exactly, mutations stay plain
`client.*` calls (`client.deleteAuthOrganization(...)`, `client.banAuthUser(...)`,
etc.) — this plan is explicitly out-of-scope for touching the client methods.
The hook contract's job is to make the **paired read's refetch** a stable,
exported function so a caller can compose `await client.mutate(...); list.refetch()`
exactly like Studio's `onDone={refetchOrgs}` callback prop. No hidden
invalidation-on-mutate magic — the caller decides when a write should
invalidate which read, same as today.

`useImpersonate` is the one mutation-shaped hook (wraps
`client.impersonateAuthUser`, TanStack `useMutation` under it) since minting
an impersonation token has no paired list to invalidate — see the security
note below for why it also does not call `client.setAuthToken()` itself.

## Hooks-only vs hooks + copy-in console — RECOMMENDATION: hooks first, defer the console

Ship the hook layer as the immediate, scoped deliverable; treat a full
copy-in admin console (auth-ui-style, per adapter) as its own follow-up plan,
not bundled here. Reasoning:

- **The asymmetry is in the hooks, not the UI.** Studio's panels
  (`organizations-panel.tsx`, `users-panel.tsx`, …) are ~150-300 lines each of
  mostly Tailwind table/dialog markup wrapped around a 5-10 line data
  contract. The expensive, adapter-specific, error-prone part is the
  reactive-data wiring (this spike); the UI is comparatively mechanical
  copy-paste-and-reskin work once the contract is proven.
- **Five adapters' worth of UI is a large, opinionated surface.** Vue/Solid/
  Svelte/Angular don't share Studio's shadcn/Tailwind component library, so a
  "port" is a from-scratch UI build per framework, not a mechanical
  translation — that's real product-design work (dialogs, tables, drawers,
  confirm flows) that deserves its own scoping, not a rider on a hooks spike.
- **Hooks alone already close the stated gap.** The plan's WHY is "every
  multi-tenant SaaS on Lunora rebuilds user/org/team/session admin dashboards
  by hand: manual loading/error/pagination, no reuse across adapters." A
  typed, tested `useAuthUsers`/`useOrganizations`/`useAuthSessions`/
  `useImpersonate` per adapter removes the "manual loading/error/pagination"
  half of that pain immediately, and lets an app team build their _own_
  admin UI on top (most SaaS admin panels are heavily branded/opinionated
  anyway — a generic copy-in console is a smaller fraction of the value than
  the hooks are).
- **If/when a copy-in console is built**, the reference is lifting
  `packages/studio/src/features/auth/*` into an `@lunora/auth-ui`-style port
  (the existing `packages/auth-ui/src/{react,vue,solid,svelte,angular}`
  copy-in pattern, which today covers _authentication_ screens only — sign-in/
  up/OTP/magic-link, no admin/org management). That reuse is exactly why
  scoping it separately matters: it's an `auth-ui` expansion, not a
  `@lunora/react` hooks change, and should be planned against that package's
  existing copy-in tooling and conventions.

## Cross-adapter shape (for the eventual port)

**Correction to an assumption checked while writing this doc**: only
`@lunora/react` depends on TanStack Query (`packages/react/package.json`).
The other four adapters do **not** — `@lunora/vue`'s `use-query.ts` is a
`shallowRef` + `watch` composable wired straight to `client.subscribe()`
(via `@lunora/client/query`'s `createQuerySubscription`); `@lunora/solid`,
`@lunora/svelte`, `@lunora/angular` are the equivalent framework-native
primitives (`create-query.ts`, a Svelte store, an Angular signal) — none of
them route through `@tanstack/{vue,solid,svelte,angular}-query`. So the
"same TanStack primitive in every adapter" framing this doc initially reached
for is wrong; corrected below.

That said, the port is still mechanical — for a different reason. These
admin-auth reads are **not** live subscriptions (see above): they're a plain
`Promise`-returning method call (`client.listAuthUsers(...)`) plus a page
size in local state. Every adapter already has a "hold an async result in the
framework's reactive primitive" idiom, because every adapter needs one for
things that aren't `client.subscribe`-shaped either (e.g. `use-agent.ts`'s
imperative calls, upload progress). Porting this contract doesn't require
introducing TanStack Query into four packages that don't have it — it only
requires each adapter's own "async call → reactive value + loading/error
state" idiom, applied to `client.listAuthUsers`/`listAuthOrganizations`/
`listAuthSessions`/`impersonateAuthUser` instead of a `FunctionReference`:

| Concept     | React (this spike)                                                                                                 | Vue                                                                         | Solid                                                                      | Svelte                                                           | Angular                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| List read   | `useAuthUsers()` → `{ data, loading, error, hasMore, loadMore, refetch }` (`@tanstack/react-query`, already a dep) | `useAuthUsers()` composable → same shape via `ref`/`watch` (no new dep)     | `createAuthUsers()` → same shape via `createResource`/signals (no new dep) | `authUsers()` store → same shape via a Svelte store (no new dep) | `injectAuthUsers()` → same shape via Angular signals (no new dep) |
| Mutation    | Plain `client.*` call + hook's `refetch()`                                                                         | same                                                                        | same                                                                       | same                                                             | same                                                              |
| Impersonate | `useImpersonate()` → `{ impersonate, pending, data, error, reset }` (`useMutation`)                                | `useImpersonate()` composable, same fields, hand-rolled pending/error state | `createImpersonate()`, signals                                             | `impersonate()` store/action                                     | `injectImpersonate()`, signals                                    |

What's genuinely shared and mechanical across the port is the **contract**
settled in this doc (one-shot, `{data, total, loading, error, hasMore,
loadMore, refetch}`, growing-window pagination, plain-call mutations, the
impersonation non-swap stance) — each adapter implements it against its own
existing async-state idiom, none of them needs a new dependency to do it.

## Open questions (STOP conditions / follow-ups)

1. **Impersonation's session-swap boundary.** Studio's `user-detail-drawer.tsx`
   (`onImpersonate`, line 145) mints the token via `client.impersonateAuthUser`
   and displays it in a **read-only text input** (`ud-token`) — it never calls
   `client.setAuthToken(token)` on the admin's own client instance. This is
   deliberate: auto-swapping the _current_ session would silently sign the
   admin out of their own admin session with no visible transition and no
   easy "return to admin" path. The prototype's `useImpersonate` preserves
   this: it resolves the `AuthImpersonation` (token + user + expiry) and lets
   the caller decide what to do with it (open a new tab/incognito window,
   store it for an explicit "Acting as X — Return to admin" banner flow,
   etc.) rather than silently swapping. **Open**: what the _real_ UX should
   be (a dedicated impersonation banner + explicit swap-back, vs. always
   requiring a second tab) is a product decision Studio itself ducks today —
   worth its own short design note before a copy-in console builds on it,
   since a console (unlike raw hooks) has to pick one behavior.
2. **`loadMore`'s growing-window cost.** Fine for typical admin-dashboard
   list sizes; a deployment with very large user/session counts would refetch
   an ever-larger window on each `loadMore` rather than appending a page.
   Worth revisiting if/when this becomes the shipped cross-adapter contract —
   possibly switch to true offset-increment pages (`rows` concatenation)
   once real usage data exists.
3. **Copy-in console scope + timing.** Recommended as its own follow-up plan
   (see above) — not scoped or estimated here.
4. **Parity gate (plan 233).** Once a second adapter ports this contract, the
   parity gate should check for the same four hook names + return-shape
   fields across adapters (mirroring however it already checks
   `useQuery`/`useMutation`/`useAuth` parity) — no new mechanism, just adding
   these names to whatever surface list that gate already walks. Not
   implemented in this spike (no second adapter exists yet to gate against).
5. **Auth-admin methods missing from a hand-maintained public type.** Not a
   blocker for this spike (confirmed `LunoraClient` is exported as the class
   itself, so `useLunora()`'s return type already carries every admin method
   with full inference — no gap here), but worth noting as a thing that
   _could_ have silently drifted the way `packages/client/src/types.ts`'s
   `LunoraClientOptions` is hand-maintained separately; it happened not to
   apply to the client's own instance type.

## Recommendation summary

- Live vs one-shot: **one-shot**, TanStack-Query-backed, explicit `refetch`.
  Confirmed by transport structure (`adminFetch` vs the WS machinery) and by
  Studio's own `useClientQuery`/`useAdminQuery` split + code comments.
- Hooks vs hooks+console: **hooks now**, console scoped as a separate future
  plan reusing `packages/studio/src/features/auth/*` as the UI reference.
- Contract: `{ data, total, loading, error, hasMore, loadMore, refetch }` for
  reads; plain `client.*` calls + the paired hook's `refetch()` for mutations;
  a dedicated `useImpersonate` for the one true mutation among the four
  prototyped hooks.
- Cross-adapter: mechanical, since every adapter already depends on its
  framework's TanStack Query binding for live queries.
