# SaaS UI — React

The kit's screens, copied into your project and yours to edit: the dashboard stat
row, the project list with its create form and search/sort toolbar, the activity
feed grouped by day, and the platform admin's organization table.

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

Your route owns the subscription:

```tsx
import { ActivityFeed, AdminOrganizations, OverviewStats, ProjectsCard } from "./lunora/saas-ui/react";

const payload = useQuery(api.saas.overview, {});
const createProject = useMutation(api.saas.createProject);

<OverviewStats now={Date.now()} payload={payload} />
<ProjectsCard canWrite={isAdmin} onArchive={archive} onCreate={(name) => createProject({ name })} rows={payload?.projects} />
```

Every query is live, so a project created in one tab appears in the others
without a reload.

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
