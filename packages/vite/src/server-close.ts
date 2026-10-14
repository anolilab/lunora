/**
 * Dev-server close registration that also works in middleware mode.
 *
 * `server.httpServer` is null when `server.middlewareMode: true` (programmatic
 * hosts), so a plain `httpServer.once("close", …)` registration never fires
 * there. Vite's `server.close()` always closes every environment
 * (`environment.close()`) regardless of middleware mode, which invokes each
 * eligible plugin's `buildEnd` hook once for the "client" environment — a
 * reliable middleware-safe close signal. A plugin pairs
 * {@link registerDevServerClose} (in `configureServer`) with
 * {@link runPendingClose} (in its `buildEnd` hook) over one plugin-scoped
 * {@link PendingCloseMap}.
 *
 * The pending map is keyed by the Environment INSTANCE rather than a single
 * "current" callback: `server.restart()` configures + registers the NEW
 * server's callback BEFORE closing the OLD one (Vite's `restartServer` creates
 * and configures the replacement server, then awaits the old server's
 * `close()`), so a shared mutable reference would let the old server's close
 * invoke the new server's callback instead of its own. Entries are consumed
 * (deleted) when they fire, so the map never retains closed environments.
 */
import type { Environment, ViteDevServer } from "vite";

/** Per-plugin registry of close callbacks pending a middleware-mode dev-server close. */
export type PendingCloseMap = Map<Environment, () => void>;

/**
 * Register `onClose` to run when `server` closes: via `httpServer.once("close")`
 * in classic mode, else parked in `pending` for the plugin's `buildEnd` hook to
 * consume (see {@link runPendingClose}) in middleware mode. `onClose` should be
 * idempotent — some hosts can deliver both signals for one server.
 */
export const registerDevServerClose = (server: ViteDevServer, pending: PendingCloseMap, onClose: () => void): void => {
    if (server.httpServer) {
        server.httpServer.once("close", onClose);
    } else {
        pending.set(server.environments.client, onClose);
    }
};

/**
 * Consume and run the pending close callback for `environment`, if any. Call it
 * from the plugin's `buildEnd` hook — a no-op in classic dev mode (the map is
 * only populated in middleware mode), for environments with nothing parked, and
 * for production builds of `apply: "serve"` plugins (their map is never filled).
 */
export const runPendingClose = (pending: PendingCloseMap, environment: Environment): void => {
    const onClose = pending.get(environment);

    if (onClose !== undefined) {
        pending.delete(environment);
        onClose();
    }
};
