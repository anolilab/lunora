/**
 * The Node {@link DeployDriver} — the second registered target.
 *
 * It exists so `lunora.json`'s `"target": "node"` resolves and codegen can gate
 * the emitted `ctx.*` surface against `NODE_CAPABILITIES` (`@lunora/platform`),
 * which is the only thing this target actually needs from the registry.
 *
 * `toolchain` is deliberately **absent**. `DriverToolchain` describes a vendor
 * CLI to shell out to — `wrangler deploy`, `wrangler tail`, `wrangler secret
 * put` — and Node has none: there is no hosted control plane to deploy to, no
 * remote log stream to tail, and no remote secret store to write. The interface
 * already models this ("or `undefined` for a host that has none"), and claiming
 * a toolchain here would mean inventing commands that cannot run.
 *
 * **What that costs the target, stated plainly.** `lunora deploy` and `lunora
 * dev` both refuse it at selection (`resolveRunnableTargetOrError` in
 * `@lunora/cli`) rather than after codegen has already rewritten `_generated/*`
 * for it. What this target IS good for is everything before that line:
 * `lunora codegen --target node` gates the emitted surface, and running the
 * result is the operator's own `@lunora/platform-node` process.
 *
 * That process is also where the target's gaps get reported. This file used to
 * carry an `infer`/`provision` pair naming them — containers have no Node
 * equivalent, and nothing walks the generated `LUNORA_CRONS` map into
 * `SchedulerHost.cron`, so a declared cron never fires here. Nothing ever
 * called either method, so no operator could read either warning; the honest
 * home for both is `NODE_CAPABILITIES`, which codegen does consult and which
 * rates them for exactly this reason.
 */

import type { DeployDriver } from "../deploy-driver";

const NODE_DRIVER: DeployDriver = {
    id: "node",
    name: "Node",
};

export default NODE_DRIVER;
