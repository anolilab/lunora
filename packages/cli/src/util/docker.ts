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

/**
 * True when the `railpack` binary is on PATH and a BuildKit endpoint is
 * configured (Railpack builds need a BuildKit instance reachable via
 * `BUILDKIT_HOST`). Quiet by design — callers own the messaging. Like
 * {@link isDockerAvailable}, this is a {@link DockerProbe} so tests can inject a
 * stub instead of probing the host.
 */
const isRailpackAvailable: DockerProbe = () => {
    if (typeof process.env.BUILDKIT_HOST !== "string" || process.env.BUILDKIT_HOST.length === 0) {
        return false;
    }

    try {
        // eslint-disable-next-line sonarjs/no-os-command-from-path -- `railpack` resolves from PATH (install location varies); args are fixed and no shell is involved
        return spawnSync("railpack", ["--version"], { stdio: "ignore" }).status === 0;
    } catch {
        return false;
    }
};

export type { DockerProbe };
export { isDockerAvailable, isRailpackAvailable };
