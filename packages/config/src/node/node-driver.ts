/**
 * The Node {@link DeployDriver} — the second registered target.
 *
 * It exists so `lunora.config.*`'s `"target": "node"` resolves and codegen can gate
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
 * **What that costs the target, stated plainly.** `lunora dev` refuses it at
 * selection (`resolveRunnableTargetOrError` in `@lunora/cli`) rather than after
 * codegen has already rewritten `_generated/*` for it. `lunora deploy` does
 * not need a toolchain for it: it writes a container build context (a bundled
 * `@lunora/platform-node` server, a Dockerfile, the env it reads) and builds
 * the image only when asked (`resolveDeployTargetOrError`). Running and
 * hosting that container is the operator's.
 *
 * That process is also where the target's gaps get reported. This file used to
 * carry an `infer`/`provision` pair naming them. Nothing ever called either
 * method, so no operator could read either warning; the honest home for the
 * gaps is `NODE_CAPABILITIES`, which codegen does consult.
 */

import type { DeployDriver } from "../deploy-driver";

const NODE_DRIVER: DeployDriver = {
    id: "node",
    name: "Node",
};

export default NODE_DRIVER;
