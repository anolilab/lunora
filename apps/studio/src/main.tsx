import "./index.css";

import { mountStudio } from "@lunora/studio/mount";

// The studio talks to a remote Lunora worker. Point it at one via
// `VITE_LUNORA_URL` (e.g. `https://my-app.workers.dev`); when unset it falls
// back to the current origin, which is right when this app is reverse-proxied
// in front of the worker.
const baseUrl = (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? undefined;

// `VITE_LUNORA_ADMIN_TOKEN` pre-fills the admin token in dev; in production
// leave it unset and paste the token into the header field at runtime so it's
// never baked into the bundle.
const adminToken = (import.meta.env.VITE_LUNORA_ADMIN_TOKEN as string | undefined) ?? undefined;

mountStudio({ adminToken, baseUrl });
