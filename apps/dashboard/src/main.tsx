import { mountDashboard } from "@cirrus/dashboard/mount";

import "./index.css";

// The dashboard talks to a remote Cirrus worker. Point it at one via
// `VITE_CIRRUS_URL` (e.g. `https://my-app.workers.dev`); when unset it falls
// back to the current origin, which is right when this app is reverse-proxied
// in front of the worker.
const baseUrl = (import.meta.env.VITE_CIRRUS_URL as string | undefined) ?? undefined;

// `VITE_CIRRUS_ADMIN_TOKEN` pre-fills the admin token in dev; in production
// leave it unset and paste the token into the header field at runtime so it's
// never baked into the bundle.
const adminToken = (import.meta.env.VITE_CIRRUS_ADMIN_TOKEN as string | undefined) ?? undefined;

mountDashboard({ adminToken, baseUrl });
