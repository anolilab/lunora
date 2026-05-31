import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";

import { createRouter } from "./router";

/**
 * SSR entry: TanStack Start wires this into the Cloudflare worker preset.
 * Each request gets a fresh router; the QueryClient inside it absorbs
 * any `preloadQuery` calls made by routes so the client hydrates without
 * an extra fetch.
 */
export default createStartHandler({ createRouter })(defaultStreamHandler);
