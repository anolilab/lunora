/**
 * The sibling Workers this app calls (plan 457). Each becomes a typed
 * `ctx.services.<key>` in actions, a wrangler `services[]` binding, and an
 * auxiliary Worker in `vite dev` / `lunora dev`.
 */
export default {
    services: {
        // An RPC service: `entrypoint` names its exported WorkerEntrypoint class.
        gateway: { dir: "./services/gateway", entrypoint: "Gateway" },
        // A fetch service: any Worker with a `fetch` handler.
        parser: { dir: "./services/parser" },
    },
};
