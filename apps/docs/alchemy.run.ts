import { appendFileSync, readFileSync } from "node:fs";

import alchemy from "alchemy";
import { KVNamespace, RateLimit, TanStackStart } from "alchemy/cloudflare";
import { CloudflareStateStore } from "alchemy/state";
import { parse } from "jsonc-parser";

// Deployed by `.github/workflows/deploy-docs.yml` (stage `prod` on a push to alpha, stage
// `pr-<number>` for a labelled pull request), or by hand with `pnpm run deploy`. Credentials
// come from CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment, never from
// this file; ALCHEMY_PASSWORD encrypts the Turnstile secret in alchemy's state.
//
// State lives in a Durable Object in the Cloudflare account (ALCHEMY_STATE_TOKEN signs
// access to it), not on the runner: a CI runner starts empty, so local state would
// orphan every resource and redeploy over them. The token must be the same for every
// deploy to the account.
const app = await alchemy("lunora-docs", { stateStore: (scope) => new CloudflareStateStore(scope) });

const production = app.stage === "prod";

// A destroy runs this same script. It builds nothing and needs no keys, so the deploy
// guards stand down.
const destroying = app.phase === "destroy";

// The waitlist form's Turnstile keys. The site key is read by `vite build`, which
// would otherwise fall back to Cloudflare's always-passing test key, so a deploy
// without it is refused here rather than shipping a form the real secret rejects.
if (!destroying && !process.env.VITE_TURNSTILE_SITE_KEY) {
    throw new Error("VITE_TURNSTILE_SITE_KEY must be set to the Turnstile site key (the production one for stage prod)");
}

// Only prod adopts: a namespace with this title, if one exists, keeps its stored
// sign-ups, and destroying the stage never deletes it. Any other stage gets a
// namespace of its own that goes with it; sharing the prod title would let a preview
// read the real list and a destroy wipe it. The binding name matches `WAITLIST` in
// src/routes/api/waitlist.ts.
const waitlist = await KVNamespace("WAITLIST", {
    adopt: production,
    delete: !production,
    title: production ? "lunora-docs-waitlist" : `lunora-docs-waitlist-${app.stage}`,
});

// The sign-up limit is defined once, in wrangler.jsonc, so local runs and the deployed
// Worker enforce the same numbers.
interface WranglerRateLimit {
    name: string;
    namespace_id: string;
    simple: { limit: number; period: 10 | 60 };
}

const { ratelimits = [] } = parse(readFileSync(new URL("wrangler.jsonc", import.meta.url), "utf8")) as { ratelimits?: WranglerRateLimit[] };
const limiterConfig = ratelimits.find(({ name }) => name === "WAITLIST_LIMITER");

if (!limiterConfig) {
    throw new Error("wrangler.jsonc must define the WAITLIST_LIMITER rate limit");
}

const waitlistLimiter = RateLimit({ namespace_id: Number(limiterConfig.namespace_id), simple: limiterConfig.simple });

// Attaching the hostname is the DNS cutover from the previous host, so it is opt-in: set
// the `docs-production` variable DOCS_CUSTOM_DOMAIN to the hostname once the zone is
// active in this account and its old record is gone. Until then the stage answers on
// workers.dev only. A preview never takes the domain.
const customDomain = production ? process.env.DOCS_CUSTOM_DOMAIN?.trim() : undefined;

// The package's full build: it generates the package pages, error reference and stats before `vite build`.
// dist/client is uploaded as static assets.
const site = await TanStackStart("lunora-docs", {
    bindings: { TURNSTILE_SECRET_KEY: alchemy.secret.env.TURNSTILE_SECRET_KEY, WAITLIST: waitlist, WAITLIST_LIMITER: waitlistLimiter },
    build: "pnpm run build",
    compatibilityDate: "2026-10-01",
    domains: customDomain ? [{ adopt: true, domainName: customDomain }] : undefined,
    url: true,
});

// The workflow reads the address from here rather than scraping the CLI's output.
if (!destroying && process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `website-url=${customDomain ? `https://${customDomain}` : (site.url ?? "")}\n`);
}

await app.finalize();
