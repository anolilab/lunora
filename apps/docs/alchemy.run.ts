import alchemy from "alchemy";
import { KVNamespace, TanStackStart } from "alchemy/cloudflare";

// Deployed with `pnpm run deploy`. Credentials come from CLOUDFLARE_ACCOUNT_ID and
// CLOUDFLARE_API_TOKEN in the environment, never from this file.
const app = await alchemy("lunora-docs");

// Adopt rather than create: a namespace with this title, if one exists, keeps its
// stored sign-ups. The binding name matches `WAITLIST` in src/routes/api/waitlist.ts.
const waitlist = await KVNamespace("WAITLIST", { adopt: true, title: "lunora-docs-waitlist" });

// The package's full build: it generates the package pages, error reference and stats before `vite build`.
// dist/client is uploaded as static assets.
await TanStackStart("lunora-docs", {
    bindings: { WAITLIST: waitlist },
    build: "pnpm run build",
    compatibilityDate: "2026-10-01",
});

await app.finalize();
