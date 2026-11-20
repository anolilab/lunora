import alchemy from "alchemy";
import { KVNamespace, RateLimit, TanStackStart } from "alchemy/cloudflare";

// Deployed with `pnpm run deploy`. Credentials come from CLOUDFLARE_ACCOUNT_ID and
// CLOUDFLARE_API_TOKEN in the environment, never from this file; ALCHEMY_PASSWORD
// encrypts the Turnstile secret in alchemy's state.
const app = await alchemy("lunora-docs");

// The waitlist form's Turnstile keys. The site key is read by `vite build`, which
// would otherwise fall back to Cloudflare's always-passing test key, so a deploy
// without it is refused here rather than shipping a form the real secret rejects.
if (!process.env.VITE_TURNSTILE_SITE_KEY) {
    throw new Error("VITE_TURNSTILE_SITE_KEY must be set to the production Turnstile site key");
}

// Adopt rather than create: a namespace with this title, if one exists, keeps its
// stored sign-ups. The binding name matches `WAITLIST` in src/routes/api/waitlist.ts.
const waitlist = await KVNamespace("WAITLIST", { adopt: true, title: "lunora-docs-waitlist" });

// Sign-ups per client address: five a minute covers a typo and a retry. The namespace
// id is the account-wide key the limit's counters live under, so keep it stable.
const waitlistLimiter = RateLimit({ namespace_id: 1001, simple: { limit: 5, period: 60 } });

// The package's full build: it generates the package pages, error reference and stats before `vite build`.
// dist/client is uploaded as static assets.
await TanStackStart("lunora-docs", {
    bindings: { TURNSTILE_SECRET_KEY: alchemy.secret.env.TURNSTILE_SECRET_KEY, WAITLIST: waitlist, WAITLIST_LIMITER: waitlistLimiter },
    build: "pnpm run build",
    compatibilityDate: "2026-10-01",
});

await app.finalize();
