import { applyModify } from "../jsonc-edit";
import type { ReconcileStep, WranglerShape } from "./wrangler-shape";

/**
 * The paths the Lunora Worker owns outright. `/_lunora/*` is the RPC, WebSocket,
 * REST, health and admin plane; `/__lunora/*` carries the hosted Studio's advisor
 * route, which sits outside the single-underscore prefix (see `create-worker.ts`).
 *
 * Workers Static Assets answers a request from the assets directory before the
 * Worker whenever a file matches, and under `not_found_handling:
 * "single-page-application"` a browser navigation to ANY unmatched path gets
 * `index.html`. Either way a request meant for these paths never reaches Lunora
 * unless `run_worker_first` names them.
 */
const LUNORA_WORKER_FIRST_PATHS: ReadonlyArray<string> = ["/_lunora/*", "/__lunora/*"];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Reserved paths an authored `run_worker_first` leaves to the assets, so the caller can say which ones. */
const unroutedPaths = (runWorkerFirst: unknown): string[] => {
    if (runWorkerFirst === true) {
        return [];
    }

    const rules = Array.isArray(runWorkerFirst) ? runWorkerFirst : [];

    return LUNORA_WORKER_FIRST_PATHS.filter((path) => !rules.includes(path));
};

/**
 * Route Lunora's reserved paths to the Worker ahead of the assets: writes
 * `assets.run_worker_first` with {@link LUNORA_WORKER_FIRST_PATHS} on every
 * `assets` block (top level and `env.<name>`) that does not set the key. An
 * authored value is never rewritten; when it leaves a reserved path to the assets
 * the step warns instead. Pure.
 */
const reconcileAssetRouting = (text: string, parsed: WranglerShape): ReconcileStep => {
    const scopes: { assets: unknown; path: string[] }[] = [{ assets: parsed.assets, path: ["assets"] }];

    for (const [name, block] of Object.entries(parsed.env ?? {})) {
        if (isRecord(block)) {
            scopes.push({ assets: block["assets"], path: ["env", name, "assets"] });
        }
    }

    let nextText = text;
    const added: string[] = [];
    const warnings: string[] = [];

    for (const { assets, path } of scopes) {
        if (!isRecord(assets)) {
            continue;
        }

        const label = `${path.join(".")}.run_worker_first`;

        if (assets["run_worker_first"] === undefined) {
            nextText = applyModify(nextText, [...path, "run_worker_first"], [...LUNORA_WORKER_FIRST_PATHS]);
            added.push(label);

            continue;
        }

        const missing = unroutedPaths(assets["run_worker_first"]);

        if (missing.length > 0) {
            warnings.push(
                `${label} does not send ${missing.join(", ")} to the Worker first, so a matching file in the assets directory (or the SPA fallback) answers instead of Lunora — add ${missing.map((entry) => `"${entry}"`).join(", ")} to it`,
            );
        }
    }

    return { added, text: nextText, warnings };
};

export { LUNORA_WORKER_FIRST_PATHS, reconcileAssetRouting };
