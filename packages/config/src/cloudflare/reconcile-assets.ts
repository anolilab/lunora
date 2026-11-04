import { applyModify } from "../jsonc-edit";
import type { Manifest } from "./lunora-manifest";
import { recordManifestKey } from "./lunora-manifest";
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

/** Cloudflare's caps on `assets.run_worker_first`: rules per list, and characters per rule. */
const MAX_RULES = 100;
const MAX_RULE_LENGTH = 100;

/** Where `package.json`'s `lunora` object records the `run_worker_first` values reconcile wrote, by scope. */
const RUN_WORKER_FIRST_RECORD = "runWorkerFirst";

/** `assets` path → the rules Lunora last wrote there. */
type OwnedRunWorkerFirst = Record<string, string[]>;

/** A path segment that names itself: no `:param`, `*` splat, `{regex}` or `?` optional, and nothing a rule pattern would read. */
const PLAIN_SEGMENT = /^[\w.~@%+-]+$/u;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The `run_worker_first` rules that send `route` to the Worker, widened to its
 * static prefix the way Void does (`/posts/:slug` → `/posts/*`): a pattern rule
 * cannot express a parameter. A route ending in a splat also keeps its bare
 * prefix (`/files/*` → `/files`, `/files/*`), since `/files/*` does not match
 * `/files`. `undefined` when the route starts with a parameter: its only
 * prefix is `/`, and sending everything to the Worker is not a narrowing.
 */
const workerPathRules = (route: string): string[] | undefined => {
    const segments = route.split("/").filter((segment) => segment !== "");
    const dynamic = segments.findIndex((segment) => !PLAIN_SEGMENT.test(segment));

    if (dynamic === 0 || segments.length === 0) {
        return undefined;
    }

    if (dynamic === -1) {
        return [`/${segments.join("/")}`];
    }

    const prefix = `/${segments.slice(0, dynamic).join("/")}`;

    return dynamic === segments.length - 1 && segments[dynamic] === "*" ? [prefix, `${prefix}/*`] : [`${prefix}/*`];
};

/** Whether `rule` is already covered by `wider` (`/api/*` covers `/api/x` and `/api/x/*`). */
const coveredBy = (rule: string, wider: string): boolean => wider !== rule && wider.endsWith("/*") && rule.startsWith(wider.slice(0, -1));

/**
 * The full rule list for `routes`: the reserved paths first, then each route's
 * widened rules, deduplicated, with every rule another one covers dropped, and
 * sorted so the same routes always write the same list. Rules past Cloudflare's
 * caps are dropped and named in `warnings`.
 */
const planRunWorkerFirst = (routes: ReadonlyArray<string>): { rules: string[]; warnings: string[] } => {
    const warnings: string[] = [];
    const widened = new Set<string>();

    for (const route of routes) {
        const rules = workerPathRules(route);

        if (rules === undefined) {
            warnings.push(
                `the route "${route}" starts with a parameter, so no run_worker_first rule narrows it; a file in the assets directory at a matching path answers instead of the Worker`,
            );

            continue;
        }

        for (const rule of rules) {
            if (rule.length > MAX_RULE_LENGTH) {
                warnings.push(`run_worker_first rule "${rule}" is longer than Cloudflare's ${String(MAX_RULE_LENGTH)} characters and was left out`);
            } else {
                widened.add(rule);
            }
        }
    }

    const all = [...LUNORA_WORKER_FIRST_PATHS, ...widened];
    const kept = [...new Set(all)].filter((rule) => !all.some((wider) => coveredBy(rule, wider)));
    const routeRules = kept.filter((rule) => !LUNORA_WORKER_FIRST_PATHS.includes(rule)).toSorted((a, b) => a.localeCompare(b));
    const room = MAX_RULES - LUNORA_WORKER_FIRST_PATHS.length;

    if (routeRules.length > room) {
        warnings.push(
            `the routes need ${String(routeRules.length + LUNORA_WORKER_FIRST_PATHS.length)} run_worker_first rules and Cloudflare accepts ${String(MAX_RULES)}; ${routeRules
                .slice(room)
                .join(", ")} were left out`,
        );
    }

    return { rules: [...LUNORA_WORKER_FIRST_PATHS, ...routeRules.slice(0, room)], warnings };
};

/** Reserved paths an authored `run_worker_first` leaves to the assets, so the caller can say which ones. */
const unroutedPaths = (runWorkerFirst: unknown, wanted: ReadonlyArray<string>): string[] => {
    if (runWorkerFirst === true) {
        return [];
    }

    const rules = Array.isArray(runWorkerFirst) ? (runWorkerFirst as unknown[]) : [];

    return wanted.filter((path) => !rules.includes(path) && !rules.some((rule) => typeof rule === "string" && coveredBy(path, rule)));
};

const sameRules = (left: unknown, right: ReadonlyArray<string> | undefined): boolean =>
    Array.isArray(left) && left.length === right?.length && left.every((rule, index) => rule === right[index]);

/** The rules recorded per scope in the manifest, or `{}` when nothing usable is recorded. */
const readOwnedRunWorkerFirst = (manifest: Manifest | undefined): OwnedRunWorkerFirst => {
    const recorded = manifest?.lunora?.[RUN_WORKER_FIRST_RECORD];

    if (!isRecord(recorded)) {
        return {};
    }

    return Object.fromEntries(
        Object.entries(recorded).filter((scope): scope is [string, string[]] => Array.isArray(scope[1]) && scope[1].every((rule) => typeof rule === "string")),
    );
};

const recordOwnedRunWorkerFirst = (manifest: Manifest, owned: OwnedRunWorkerFirst): void => {
    recordManifestKey(manifest, RUN_WORKER_FIRST_RECORD, Object.keys(owned).length === 0 ? undefined : owned);
};

/**
 * One `assets` block: write or rewrite a `run_worker_first` Lunora owns (absent,
 * the list it recorded, or the reserved pair an earlier version wrote), or warn
 * about the paths an authored one leaves to the assets. Mutates `step`.
 */
const reconcileScope = (
    step: ReconcileStep & { owned: OwnedRunWorkerFirst },
    current: unknown,
    path: string[],
    rules: string[],
    recorded: OwnedRunWorkerFirst,
): void => {
    const scope = path.join(".");
    const label = `${scope}.run_worker_first`;

    if (current !== undefined && !sameRules(current, recorded[scope]) && !sameRules(current, LUNORA_WORKER_FIRST_PATHS)) {
        const missing = unroutedPaths(current, rules);

        if (missing.length > 0) {
            step.warnings?.push(
                `${label} does not send ${missing.join(", ")} to the Worker first, so a matching file in the assets directory (or the SPA fallback) answers instead of Lunora — add ${missing.map((entry) => `"${entry}"`).join(", ")} to it`,
            );
        }

        return;
    }

    // eslint-disable-next-line no-param-reassign -- the step is this module's accumulator, built up scope by scope
    step.owned[scope] = rules;

    if (!sameRules(current, rules)) {
        // eslint-disable-next-line no-param-reassign -- as above
        step.text = applyModify(step.text, [...path, "run_worker_first"], rules);
        (current === undefined ? step.added : (step.updated ?? [])).push(label);
    }
};

/**
 * Route the paths the Worker serves to it ahead of the assets: Lunora's reserved
 * paths plus the app's own routes (`workerRoutes`, widened to static prefixes).
 * Writes `assets.run_worker_first` on every `assets` block (top level and
 * `env.<name>`) that does not set it, and rewrites a value Lunora wrote itself
 * (recorded in `owned`, or exactly the reserved pair an earlier version wrote)
 * when the routes change. A value the user wrote or edited is never rewritten;
 * when it leaves a path to the assets the step warns instead. Pure.
 */
const reconcileAssetRouting = (
    text: string,
    parsed: WranglerShape,
    workerRoutes: ReadonlyArray<string>,
    recorded: OwnedRunWorkerFirst,
): ReconcileStep & { owned: OwnedRunWorkerFirst } => {
    const scopes: { assets: unknown; path: string[] }[] = [{ assets: parsed.assets, path: ["assets"] }];

    for (const [name, block] of Object.entries(parsed.env ?? {})) {
        if (isRecord(block)) {
            scopes.push({ assets: block["assets"], path: ["env", name, "assets"] });
        }
    }

    const plan = planRunWorkerFirst(workerRoutes);
    // The plan's own warnings concern `run_worker_first`, so a project with no assets block has nothing to hear.
    const hasAssets = scopes.some((scope) => isRecord(scope.assets));
    const step: ReconcileStep & { owned: OwnedRunWorkerFirst } = { added: [], owned: {}, text, updated: [], warnings: hasAssets ? [...plan.warnings] : [] };

    for (const { assets, path } of scopes) {
        if (isRecord(assets)) {
            reconcileScope(step, assets["run_worker_first"], path, plan.rules, recorded);
        }
    }

    return step;
};

export type { OwnedRunWorkerFirst };
export { LUNORA_WORKER_FIRST_PATHS, planRunWorkerFirst, readOwnedRunWorkerFirst, reconcileAssetRouting, recordOwnedRunWorkerFirst, workerPathRules };
