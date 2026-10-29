# SaaS UI — React

The kit's screens, copied into your project and yours to edit: the dashboard stat
row, the project list with its create form and search/sort toolbar, the activity
feed grouped by day, and the platform admin's organization, user and
subscription tables.

```bash
lunora registry add saas-ui-react
```

The `saas` server item comes with it. For sign-in and organization screens, add
`auth-ui-react` too.

## What it installs

| Path                        | What it is                                                      |
| --------------------------- | --------------------------------------------------------------- |
| `lunora/saas-ui/core/*`     | The view model — search, sort, grouping, stats, the form engine |
| `lunora/saas-ui/react/*`    | The React components                                            |
| `lunora/saas-ui/styles.css` | Token-aligned CSS. No Tailwind, no component library            |

`core/` is identical in every port — it imports no framework at all. That is
what makes restyling or replacing a view a local job, and it is why the same
logic is not written twice.

## Nothing here subscribes

The components take rows and callbacks as props. They never call `useQuery`
themselves, because the adapter differs per framework and the wiring differs per
meta-framework — a component that fetches cannot be rendered in a story, a test,
or somebody else's route.

Your route owns the subscription. The tenant's rows live on its own shard, so
every tenant call carries `{ shardKey: organizationId }`, the organization id
`api.saas.me` returns; the `saas` functions refuse to run anywhere else:

```tsx
import { ActivityFeed, AdminOrganizations, OverviewStats, ProjectsCard } from "./lunora/saas-ui/react";

const shard = { shardKey: organizationId };
const payload = useQuery(api.saas.overview, {}, shard);
// `useMutation` returns `{ mutate, pending, … }`, not a callable.
const { mutate: createProject } = useMutation(api.saas.createProject);

<OverviewStats now={Date.now()} payload={payload} />
<ProjectsCard canWrite={isAdmin} onArchive={archive} onCreate={(name) => createProject({ name }, shard)} rows={payload?.projects} />
```

Every query is live, so a project created in one tab appears in the others
without a reload.

## The admin screens

`AdminOrganizations` and `AdminSubscriptions` take rows like everything else.
`AdminUsers` is the one exception to "nothing here subscribes": users live in
better-auth's tables, not in a Lunora query, so it loads them itself through the
client you pass — better-auth's `authClient.admin`, from
`createAuthClient({ plugins: [adminClient()] })` — a page of 50 at a time, and
re-reads the current page after every suspend or unsuspend.

**`AdminSubscriptions` needs a query this item does not ship.** Its rows are
every tenant's subscriptions, and no function in the `payment` item returns
those: they come from a query over `payment_subscriptions` that you write, and
it has three jobs. It refuses anyone without the platform admin role (the
`appRole` claim, better-auth's `user.role`). It refuses to run anywhere but the
root shard — the payment tables are root-scoped, and a tenant shard holds an
empty copy that would read as "no subscriptions". And it pages with
`.paginate(paginationOpts)`, because the table only grows. The saas template
has one to copy: `adminSubscriptions` in `templates/saas/lunora/payment/index.ts`,
read in `templates/saas/src/routes/admin.tsx`. Read it with `usePaginatedQuery`,
pass the loaded rows as `rows`, and pass `onLoadMore` while more pages remain;
the totals in the header then say they cover only the rows loaded. The
organisation names come from the `organizations` prop, so the query does not
need to know the kit's tenancy table exists.

Suspending asks first: the row opens an inline step with an optional reason,
which better-auth stores and the status column shows. Suspending is a better-auth ban, which better-auth enforces: the user's sessions
are revoked and their next sign-in is refused. Unsuspending lifts it. Two delays apply. `@lunora/auth` caches the session in a signed cookie for 60 s,
so the user's next requests can still resolve for up to a minute. A live
connection the user already has open keeps streaming until it reconnects or its
session would have expired, because nothing re-checks identity on an open socket.

Impersonating hands the admin the user's session, and the admin queries refuse
that user — so the admin screen is exactly where the way back cannot live. Mount
`ImpersonationBanner` on every page instead; it renders nothing until the session
says `impersonatedBy`, then names the user and offers "Stop impersonating". Both
components call `onSessionChange` once the session has swapped: navigate there,
because the whole app now belongs to someone else.

## Two conventions worth keeping

**The clock is a prop.** Every screen takes `now` rather than calling
`Date.now()`, so a server render and the hydration after it agree on "4m ago",
and a test asserts a string instead of racing one.

**`canWrite` hides controls rather than disabling them.** The mutation checks
the caller's role anyway; a greyed-out button is a promise the server will refuse
to keep, and it only teaches a member that the product is broken for them.

## Styling

One stylesheet serves every port — the components render the same elements with
the same class names on purpose, so a restyle lands once instead of once per
framework. It reads the Lunora design tokens
(`--background`, `--foreground`, `--border`, …) through `var(--token, fallback)`,
so it inherits your theme including dark mode, and still looks right standalone.
