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
 *
 * A logged-out session also needs the `ai` binding left out of every service that
 * declares one (see `dev-config.ts`), so such a service gets a copy too.
 */
import { dirname, isAbsolute, resolve } from "node:path";

import { applyModify } from "../jsonc-edit";
import { hasCloudflareCredentials } from "./credentials";
import { withheldWorkersAi, writeDevConfig } from "./dev-config";
import { readWranglerJsonc } from "./wrangler-path";

/** The slice of a service's wrangler config this reads. */
interface ServiceConfigShape {
    ai?: { binding?: string } | null;
    build?: { command?: unknown; cwd?: unknown };
}

/** The configs to pass as `--config`, in input order, and what was done to them. */
interface ServiceDevConfigs {
    /** Unlinks every copy written. Idempotent, never throws — a no-op when none was. */
    cleanup: () => void;
    configPaths: string[];
    /** The `ai` binding names left out of a service copy for lack of Cloudflare credentials, for the dev warning. */
    withheld: string[];
}

interface ServiceMaterializeOptions {
    /** Whether wrangler can authenticate; defaults to a probe of `projectRoot`. */
    hasCredentials?: () => boolean;
    /** The app's folder, where `wrangler dev` runs and whose `.env` files it reads. */
    projectRoot: string;
}

/**
 * The config `wrangler dev` should run for one service: the service's own file,
 * or a copy beside it when the service needs a change. A copy is needed when its
 * `build.command` has a relative (or no) `build.cwd`, or when it declares an `ai`
 * binding a logged-out session must leave out. Beside it, not in a temp dir, so the
 * copy's other relative paths (`main`, `assets`, `migrations_dir`, …) still resolve
 * against the service's folder.
 */
const materializeOne = (wranglerPath: string, options: ServiceMaterializeOptions): { cleanup?: () => void; configPath: string; withheld?: string } => {
    const { parsed, text } = readWranglerJsonc<ServiceConfigShape>(wranglerPath);
    const build = parsed?.build;
    const withheld = withheldWorkersAi(parsed?.ai, options.hasCredentials ?? (() => hasCloudflareCredentials({ projectRoot: options.projectRoot })));
    const needsBuildCwd = typeof build?.command === "string" && build.command !== "" && !(typeof build.cwd === "string" && isAbsolute(build.cwd));

    if (!needsBuildCwd && withheld === undefined) {
        return { configPath: wranglerPath };
    }

    const directory = dirname(wranglerPath);
    let contents = text;

    if (withheld !== undefined) {
        contents = applyModify(contents, ["ai"], undefined);
    }

    if (needsBuildCwd) {
        contents = applyModify(contents, ["build", "cwd"], resolve(directory, typeof build.cwd === "string" ? build.cwd : "."));
    }

    const written = writeDevConfig(directory, "service", contents);

    return { cleanup: written.cleanup, configPath: written.configPath, withheld };
};

/**
 * Resolve the `--config` path of each service the shared `wrangler dev` session
 * runs, writing a copy only for a service that needs one (see the module doc).
 */
const materializeServiceDevConfigs = (wranglerPaths: ReadonlyArray<string>, options: ServiceMaterializeOptions): ServiceDevConfigs => {
    const resolved = wranglerPaths.map((path) => materializeOne(path, options));
    const disposers = resolved.flatMap((entry) => (entry.cleanup === undefined ? [] : [entry.cleanup]));

    return {
        cleanup: () => {
            for (const dispose of disposers) {
                dispose();
            }
        },
        configPaths: resolved.map((entry) => entry.configPath),
        withheld: resolved.flatMap((entry) => (entry.withheld === undefined ? [] : [entry.withheld])),
    };
};

export type { ServiceDevConfigs };
export { materializeServiceDevConfigs };
