/**
 * The playground's dev origin — the one place this suite decides it.
 *
 * Vite and the embedded worker share a port, so the browser's `baseURL`, the
 * server `globalSetup.ts` spawns, and the fixtures' direct `fetch`es are all
 * the same origin. They used to be five separate literals behind two env vars —
 * `LUNORA_E2E_BASE_URL`, read only by the Playwright config, and
 * `LUNORA_E2E_WORKER_URL`, read only by the specs — so setting either one sent
 * half the suite to a server the other half was not talking to. One variable,
 * one constant, read by everything.
 */
const configured = process.env.LUNORA_E2E_BASE_URL ?? "http://localhost:5173";

/** No trailing slash: every consumer appends an absolute path to this. */
export const BASE_URL = configured.replace(/\/+$/u, "");

/**
 * The port `BASE_URL` names — what the spawned `vite --strictPort` binds.
 *
 * A URL with no explicit port has none to bind, and the implicit 80/443 is not
 * something a dev server can be started on, so that is a configuration error
 * rather than a default to guess at.
 */
export const PORT = ((): string => {
    const { port } = new URL(BASE_URL);

    if (port === "") {
        throw new Error(`[e2e] LUNORA_E2E_BASE_URL must name an explicit port (got "${BASE_URL}").`);
    }

    return port;
})();
