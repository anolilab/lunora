import alchemy from "alchemy";
import { KVNamespace, TanStackStart } from "alchemy/cloudflare";

// Deployed with `pnpm run deploy`. Credentials come from CLOUDFLARE_ACCOUNT_ID and
// CLOUDFLARE_API_TOKEN in the environment, never from this file.
const app = await alchemy("lunora-docs");

// Adopt rather than create: a namespace with this title, if one exists, keeps its
// stored sign-ups. The binding name matches `WAITLIST` in src/routes/api/waitlist.ts.
const waitlist = await KVNamespace("WAITLIST", { adopt: true, title: "lunora-docs-waitlist" });

// Builds with `vite build` and uploads dist/client as static assets. The SSR
// entry and the prerendered pages are served the same way they are under
// `wrangler dev -c dist/server/wrangler.json`.
await TanStackStart("lunora-docs", {
    bindings: { WAITLIST: waitlist },
    build: "vite build",
    compatibilityDate: "2026-10-01",
});

await app.finalize();
