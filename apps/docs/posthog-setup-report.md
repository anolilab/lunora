# PostHog setup report

PostHog browser analytics is initialized globally for the TanStack Start docs site, four product events are instrumented, exception autocapture is on, and a starter dashboard exists.

> **Revised after review.** The original version of this report described the integration as complete. It was not: the `/pr/posthog` ingestion path it referred to as "existing" was wired only in the Vite dev server, so no production event could ever have reached PostHog. That gap and one other defect are fixed; both are recorded under [Defects found and fixed](#defects-found-and-fixed). Read the checklist at the end before merging — the delivery path has still never been exercised end to end.

## Setup completed

- **SDK:** The existing `posthog-js` dependency was reused; no manifest or lockfile changes were needed. `posthog-node` was not added because no server-side analytics routes were present.
- **Initialization:** `src/lib/posthog.ts` is the single browser initialization module, loaded globally from `src/routes/__root.tsx`. It reads `VITE_PUBLIC_POSTHOG_PROJECT_TOKEN` and `VITE_PUBLIC_POSTHOG_HOST`, and sends events through the first-party `/pr/posthog` path rather than to a PostHog hostname directly.
- **Ingestion path:** `api_host` is the literal string `/pr/posthog`. That path is not served by the app — it only resolves because two layers proxy it, and **both** must carry the rule:
    - **Production:** `/pr/posthog/static/*` → `eu-assets.i.posthog.com` and `/pr/posthog/*` → `eu.i.posthog.com`, as 200 rewrites in `public/_redirects`, ordered before the TanStack Start SSR catch-all.
    - **Dev:** the matching `server.proxy` entries in `vite.config.ts`.

    Change the region or the path in one layer and you must change the other. There is no shared constant; the comments in each file point at the other.

- **Environment:** Real values are set in `.env` (gitignored); the variable names are documented in `.env.example`. `VITE_PUBLIC_POSTHOG_HOST` is **not** the ingestion host — ingestion is the proxy path above. It only feeds `ui_host`, which drives the "view in PostHog" links the toolbar renders.
- **Identity:** `identify()` was skipped. This is an unauthenticated documentation/marketing site with no login, registration, logout, session, or application user model, so no stable identity source was available to wire.
- **Error tracking:** `capture_exceptions: true` is set on the global init. No additional error boundary or manual route-level capture was added.

## Events instrumented

Each `capture()` call below was confirmed present in the relevant submit/click handler. **No event has been observed arriving in PostHog** — see [Verification status](#verification-status).

| Event                    | What it measures                                                                                        | File                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `waitlist_joined`        | A visitor successfully joins the Lunora Cloud early-access waitlist.                                    | `src/pages/cloud/index.tsx:60`                                                                                      |
| `install_command_copied` | A visitor copies an installation command from the home hero, starter-kits page, or package detail page. | `src/pages/home/sections/hero.tsx:23`; `src/pages/start/install-command.tsx:21`; `src/pages/packages/detail.tsx:37` |
| `todo_added`             | A visitor adds a todo in the interactive product demonstration.                                         | `src/components/sections/agent-panel.tsx:244`                                                                       |
| `todo_toggled`           | A visitor changes a todo's completion state in the interactive product demonstration.                   | `src/components/sections/agent-panel.tsx:265`                                                                       |

`install_command_copied` carries a `location` property (`home_hero`, `starter_kits`, `package_detail`) — that is the breakdown the dashboard's copies-by-source insight groups on. `todo_toggled` carries `completed`.

Captures are intentionally personless and no PII is included in event properties. Clipboard actions are recorded on the click, not on clipboard success; the existing UI does not handle Clipboard API rejection, so a denied clipboard permission still counts as a copy.

## Defects found and fixed

**1. Production ingestion was never wired.** `api_host: "/pr/posthog"` was matched only by `server.proxy` in `vite.config.ts`, which exists exclusively in the Vite dev server. `netlify.toml` and `public/_redirects` had no such rule, so on the deployed site every `capture()` would have POSTed to `https://lunora.sh/pr/posthog`, fallen through to the SSR catch-all, and been dropped — silently, since `posthog-js` does not surface transport failures. Fixed by adding the two proxy rules to `public/_redirects`. Two rules rather than one because `posthog-js` fetches its remote config and toolbar bundles from the assets host while sending events to the ingestion host; the `/static/*` rule must sort first. They are 200 rewrites, not 30x redirects, which would break the CORS preflight on ingestion POSTs.

**2. A missing token crashed the dev server.** `src/lib/posthog.ts` did a module-scope `throw new Error(...)` when either variable was absent. Because `.env` is gitignored, that is the state of every fresh clone — so any contributor editing a docs page hit a hard crash on an analytics variable they had no reason to hold. Downgraded to a `console.warn` naming the missing variables; analytics simply stays off.

The dev proxy in `vite.config.ts` also gained the `/static` split so dev and production resolve identically.

## Dashboard

A dashboard named **Analytics basics (wizard)** was created with four insights: waitlist joins trend, installation copies broken down by source, todo additions trend, and a todo interaction funnel. The definitions use the exact event names above over the last 30 days. The dashboard exists; its data is unconfirmed, and given defect 1 it should be assumed empty for any traffic predating this fix.

[DASHBOARD_URL] https://eu.posthog.com/project/49203/dashboard/865579

## Verification status

Re-run after the fixes above:

- `pnpm run lint:types` passed.
- `pnpm exec eslint src/lib/posthog.ts --max-warnings=0` passed. The dev-only `console.warn` carries a justified `no-console` disable — the repo's config only relaxes that rule for `scripts/**` and configs, not browser source.
- `pnpm exec prettier --check` passed on `src/lib/posthog.ts` and `vite.config.ts`.

Carried over from the original run, **not** re-verified after the fixes:

- `npm run build` passed and prerendered 320 pages.
- `npm run lint:doc-imports` passed.
- No test suite was run by the integration steps.

Still unverified by anything:

- **No runtime event delivery check has been performed, in dev or production.** The proxy rules are written to the documented Netlify recipe but have not been exercised against a deploy. This is the one item that would have caught defect 1, and it remains open.

## Known limitations

- **No stable user identity.** The application has no auth model. If authentication is added without also wiring `identify()` and `reset()`, events and errors stay anonymous and can fragment across identities.
- **`npm install` does not work in this app directory.** It cannot resolve the workspace's `catalog:` dependency protocol; use `pnpm`. This did not affect the integration because `posthog-js` was already installed, but the original report's build/lint claims were produced with `npm run …`, which works only because the scripts themselves shell out to already-installed binaries.
- **Full-project Prettier reports two unrelated pre-existing failures:** the generated `src/data/packages.ts` and `src/routeTree.gen.ts`. The wizard-cache and `.netlify/` entries the original report listed here no longer apply — `.posthog-wizard-cache/` has since been deleted and `.netlify` is gitignored. All integration files pass.
- **The integration is entirely uncommitted.** `src/lib/posthog.ts`, `.env.example`, and this report are untracked; the five instrumented components, `vite.config.ts`, `public/_redirects`, and `src/routes/__root.tsx` are modified but unstaged. Decide whether this report belongs in the repo at all, and if so where — `apps/docs/` root is not where the site's other documents live.

## Before you merge

- [ ] **Verify delivery in a deploy preview.** Trigger each of the four actions and confirm the events arrive and populate the dashboard. Specifically confirm `/pr/posthog/static/*` and `/pr/posthog/*` return 200 with PostHog content and not the SSR HTML shell — that check is what defect 1 slipped past.
- [ ] Set `VITE_PUBLIC_POSTHOG_PROJECT_TOKEN` and `VITE_PUBLIC_POSTHOG_HOST` in every deploy environment, not only local `.env`. Names are in `.env.example`.
- [ ] Confirm the Netlify plan permits proxy rewrites to an external host; if not, the `/pr/posthog` design cannot work and `api_host` should point at `VITE_PUBLIC_POSTHOG_HOST` directly, accepting that ad blockers will then drop a share of events.
- [ ] Run the full production build and the test suite; update any mocks or fixtures affected by the new `capture()` calls in `src/pages/cloud/index.tsx`, `src/pages/home/sections/hero.tsx`, `src/pages/start/install-command.tsx`, `src/pages/packages/detail.tsx`, and `src/components/sections/agent-panel.tsx`.
- [ ] Decide the fate of this report file (see Known limitations), and stage the integration deliberately — several of the touched files are shared with other in-flight work in this checkout, so `git add -A` is the wrong move here.
