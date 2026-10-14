/**
 * Once-per-process-tree guards for startup notices.
 *
 * A notice several surfaces can print (`lunora dev`, the Vite plugin, the Rspack
 * plugin, a Vite restart, a child process `lunora dev` spawned) is claimed by
 * setting an env var on `process.env`. Later surfaces in the same process — and
 * every child spawned after the claim, which inherits the env — read it and stay
 * quiet.
 */

/** Whether a notice guarded by `envName` was already claimed in this process tree. */
const isClaimedInProcessTree = (envName: string): boolean => process.env[envName] === "1";

/** Claim the notice guarded by `envName`. Returns `true` the first time, `false` afterwards. */
const claimOncePerProcessTree = (envName: string): boolean => {
    if (isClaimedInProcessTree(envName)) {
        return false;
    }

    process.env[envName] = "1";

    return true;
};

export { claimOncePerProcessTree, isClaimedInProcessTree };
