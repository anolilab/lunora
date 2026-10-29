# `@lunora/browser` live smoke test

A Worker that runs the SSRF guard against a **real Browser Run binding**. The
unit and workerd suites prove the guard's decisions against fakes. This shows the
mechanisms work inside a real session: `route.fetch` / `route.fulfill`,
`serviceWorkers: "block"`, and Chromium reporting a refused request as
`net::ERR_BLOCKED_BY_CLIENT`. `@lunora/browser` stays experimental until this
passes.

Not part of the package: `package.json` `files` publishes `dist` only, and the
build (packem) only bundles `src/index.ts`. `pnpm --filter @lunora/browser run
lint:types` typechecks it.

## Requirements

- A Cloudflare account on the **Workers Paid** plan with **Browser Run**
  (Browser Rendering) available.
- `wrangler login`, or `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the
  environment.
- A `workers.dev` subdomain. The cross-origin check redirects to this version's
  preview URL (`preview_urls` is on in `wrangler.jsonc`). If preview URLs are off
  for your account, deploy with a `CROSS_ORIGIN` var set to any other origin that
  serves this same Worker.

## Run

From the repository root:

```sh
bash scripts/browser-smoke.sh
```

The script deploys the Worker with `wrangler deploy`, calls `GET /report` on its
`workers.dev` URL, prints the JSON report, and exits non-zero if any check fails.

## What it checks

`/report` runs each check in turn and answers
`{ ok, checks: [{ name, pass, detail }] }`. The Worker serves its own fixtures
(`/page`, `/img-to-metadata`, `/redirect-to-metadata`, `/redirect-to-private`,
`/sw-page`, `/sw.js`, `/xhr-auth`, `/redirect-cross-origin`, `/echo-headers`).

Default mode (no `allowedHosts`, the Worker-side guard):

1. A guarded `screenshot` of a public page returns a PNG. This proves `route.fetch`
   and `route.fulfill` work inside a real session.
2. An `<img>` whose URL 302s to `http://169.254.169.254/` fails with
   `BLOCKED_BY_CLIENT`, which is the guard's abort and not a connection error.
3. `content()` of a URL that 302s the main frame to `http://10.0.0.1/` is refused
   with `FORBIDDEN`.
4. Service-worker registration does not succeed.
5. A same-origin `fetch` with `Authorization` that 302s to a second origin reaches
   that origin without the `Authorization` header.

`allowedHosts` mode (the production posture, enforced by Browser Run guardrails):

6. A host on the list loads.
7. A host off the list is refused with `FORBIDDEN`.

## Tear down

```sh
pnpm --dir packages/browser exec wrangler delete --config smoke/wrangler.jsonc
```
