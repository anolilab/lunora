import "./index.css";

import { mountStudio } from "@lunora/studio/mount";

// The studio talks to a Lunora worker. In a static/production build, point it at
// one via `VITE_LUNORA_URL` (e.g. `https://my-app.workers.dev`); when unset it
// falls back to the current origin, which is right when this app is
// reverse-proxied in front of the worker.
//
// In the dev server we deliberately ignore `VITE_LUNORA_URL` and always use the
// current origin: vite's `/_lunora` proxy (configured from `LUNORA_DEV_PROXY`)
// forwards every HTTP + WebSocket call to the worker, so the browser only ever
// talks to one origin. A cross-origin `VITE_LUNORA_URL` would bypass the proxy
// (cross-origin HTTP + WS) and can storm the socket pool against a cold worker;
// to target a different worker in dev, change `LUNORA_DEV_PROXY`, not this.
const baseUrl = import.meta.env.PROD ? (import.meta.env.VITE_LUNORA_URL as string | undefined) : undefined;

// `VITE_LUNORA_ADMIN_TOKEN` pre-fills the admin token in dev; in production
// leave it unset and paste the token into the header field at runtime so it's
// never baked into the bundle.
const adminToken = (import.meta.env.VITE_LUNORA_ADMIN_TOKEN as string | undefined) ?? undefined;

mountStudio({ adminToken, baseUrl });
