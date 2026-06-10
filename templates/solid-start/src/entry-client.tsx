// @refresh reload
import { mount, StartClient } from "@solidjs/start/client";

// Hydrates the SSR markup. The Cirrus client + provider live in `app.tsx`, so
// once hydration completes each route's `hydratePreloaded` opens its live
// WebSocket subscription on top of the server-rendered value.
mount(() => <StartClient />, document.getElementById("app")!);
