import { spawnSync } from "node:child_process";

/**
 * Injectable probe for a Docker-compatible container engine. Tests pass a
 * stub; production uses {@link isDockerAvailable}.
 */
type DockerProbe = () => boolean;

/**
 * True when a Docker-compatible engine answers `docker info` — the same
 * prerequisite `wrangler deploy` has for building and pushing a container
 * image from a local Dockerfile. Quiet by design (output discarded): callers
 * own the messaging.
 */
const isDockerAvailable: DockerProbe = () => {
    try {
        // eslint-disable-next-line sonarjs/no-os-command-from-path -- `docker` must resolve from PATH (Docker Desktop/Colima install locations vary); args are fixed and no shell is involved
        return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
    } catch {
        return false;
    }
};

export type { DockerProbe };
export { isDockerAvailable };
