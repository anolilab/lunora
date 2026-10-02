/**
 * The per-service wrangler config `lunora dev` hands the shared `wrangler dev`
 * session (plan 457).
 *
 * The session runs the app and every `lunora.config` service from the app's
 * folder, one `--config` per service. wrangler resolves a secondary config's
 * `main` and `build.watch_dir` against that config's directory, but runs its
 * `build.command` in `build.cwd` as given — relative to the PROCESS, i.e. the
 * app. A service whose build is `./build.sh` (a Rust Worker's `worker-build`,
 * say) then fails with `not found` and its binding never connects, while the
 * same config builds fine on its own. So a service with a custom build gets a
 * sibling copy whose `build.cwd` is absolute — resolved against the service's
 * folder, which is what a standalone `wrangler dev` there would have used.
 */
import { writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { applyModify } from "../jsonc-edit";
import join from "../path";
import { createCleanup } from "./remote-bindings";
import { readWranglerJsonc } from "./wrangler-path";

/** The slice of a service's wrangler config this reads. */
interface ServiceBuildShape {
    build?: { command?: unknown; cwd?: unknown };
}

/** The configs to pass as `--config`, in input order, and a disposer for the copies written. */
interface ServiceDevConfigs {
    /** Unlinks every copy written. Idempotent, never throws — a no-op when none was. */
    cleanup: () => void;
    configPaths: string[];
}

/** Per-process counter, so successive dev-server generations never share a copy's path. */
let generation = 0;

/**
 * The config `wrangler dev` should run for one service: the service's own file,
 * or — when it declares a `build.command` with a relative (or no) `build.cwd` — a
 * copy beside it with `build.cwd` made absolute. Beside it, not in a temp dir, so
 * the copy's other relative paths (`main`, `assets`, `migrations_dir`, …) still
 * resolve against the service's folder.
 */
const materializeOne = (wranglerPath: string): { cleanup?: () => void; configPath: string } => {
    const { parsed, text } = readWranglerJsonc<ServiceBuildShape>(wranglerPath);
    const build = parsed?.build;

    if (typeof build?.command !== "string" || build.command === "" || (typeof build.cwd === "string" && isAbsolute(build.cwd))) {
        return { configPath: wranglerPath };
    }

    const directory = dirname(wranglerPath);
    const cwd = resolve(directory, typeof build.cwd === "string" ? build.cwd : ".");

    generation += 1;

    const configPath = join(directory, `.wrangler.lunora-service.${String(process.pid)}.${String(generation)}.jsonc`);

    writeFileSync(configPath, applyModify(text, ["build", "cwd"], cwd), "utf8");

    return { cleanup: createCleanup(configPath), configPath };
};

/**
 * Resolve the `--config` path of each service the shared `wrangler dev` session
 * runs, writing a copy only for a service whose custom build would otherwise run
 * in the app's folder (see the module doc).
 */
const materializeServiceDevConfigs = (wranglerPaths: ReadonlyArray<string>): ServiceDevConfigs => {
    const resolved = wranglerPaths.map((path) => materializeOne(path));
    const disposers = resolved.flatMap((entry) => (entry.cleanup === undefined ? [] : [entry.cleanup]));

    return {
        cleanup: () => {
            for (const dispose of disposers) {
                dispose();
            }
        },
        configPaths: resolved.map((entry) => entry.configPath),
    };
};

export type { ServiceDevConfigs };
export { materializeServiceDevConfigs };
