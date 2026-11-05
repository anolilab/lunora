import { isPlainObject } from "../../../../shared/is-plain-object";
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

/** Values earlier Lunora versions and templates wrote, which reconcile still owns: the reserved pair, and `rspack-react`'s `/_lunora/*` alone. */
const LEGACY_WORKER_FIRST_VALUES: ReadonlyArray<ReadonlyArray<string>> = [LUNORA_WORKER_FIRST_PATHS, ["/_lunora/*"]];

/** Cloudflare's caps on `assets.run_worker_first`: rules per list (duplicates count), and characters per rule. */
const MAX_RUN_WORKER_FIRST_RULES = 100;
const MAX_RUN_WORKER_FIRST_RULE_LENGTH = 100;

/** Where `package.json`'s `lunora` object records the `run_worker_first` values reconcile wrote, by scope. */
const RUN_WORKER_FIRST_RECORD = "runWorkerFirst";

/** `assets` path → the rules Lunora last wrote there. */
type OwnedRunWorkerFirst = Record<string, string[]>;

/** A path segment that names itself: no `:param`, `*` splat, `{regex}` or `?` optional, and nothing a rule pattern would read. */
const PLAIN_SEGMENT = /^[\w.~@%+-]+$/u;

/**
 * The `run_worker_first` rules that send `route` to the Worker. A rule is a glob
 * whose `*` matches any run of characters, `/` included, so each segment that is
 * not plain (a `:param`, a splat, a regex or optional segment) becomes `*` in
 * place: the `:id` of `/users/:id/avatar.png` turns into `*`, and the rest of the
 * path stays. Truncating at the first parameter (`/users/*`) would also take
 * `/users/42`, an SPA deep link the Worker does not serve, and answer it with the
 * Worker's 404. A route whose last segment
 * is a splat or optional also keeps its bare prefix, which `prefix/*` does not
 * match. `undefined` when the first segment is not plain, or there is none: its
 * rule would send every path to the Worker.
 */
const workerPathRules = (route: string): string[] | undefined => {
    const segments = route.split("/").filter((segment) => segment !== "");
    const plain = segments.map((segment) => PLAIN_SEGMENT.test(segment));

    if (segments.length === 0 || plain[0] === false) {
        return undefined;
    }

    const ruleSegments = segments.map((segment, index) => (plain[index] ? segment : "*"));
    const rule = `/${ruleSegments.join("/")}`;
    const last = segments.at(-1) ?? "";
    const optionalTail = last === "*" || (plain.at(-1) === false && last.endsWith("?"));

    return optionalTail ? [`/${ruleSegments.slice(0, -1).join("/")}`, rule] : [rule];
};

/** Whether `rule` is redundant beside `wider`, as wrangler judges it: `wider` ends in `*` and `rule` starts with the rest of it. */
const coveredBy = (rule: string, wider: string): boolean => wider !== rule && wider.endsWith("*") && rule.startsWith(wider.slice(0, -1));

/** Problems within one group of rules (the positive or the negative ones), as wrangler's `validateStaticRoutingRules` finds them. */
const groupProblems = (group: ReadonlyArray<string>): string[] =>
    group.flatMap((rule, index) => {
        const wider = group.find((other) => coveredBy(rule, other));

        return [
            ...(rule.length > MAX_RUN_WORKER_FIRST_RULE_LENGTH
                ? [
                      `assets.run_worker_first entry "${rule}" is ${String(rule.length)} characters; Cloudflare accepts at most ${String(MAX_RUN_WORKER_FIRST_RULE_LENGTH)}`,
                  ]
                : []),
            ...(group.indexOf(rule) === index ? [] : [`assets.run_worker_first lists "${rule}" twice`]),
            ...(wider === undefined ? [] : [`assets.run_worker_first entry "${rule}" is already covered by "${wider}", which wrangler refuses`]),
        ];
    });

/**
 * What wrangler's `parseStaticRouting` refuses in a `run_worker_first` list, so
 * the validator reports it before a deploy does: no rules, more than the cap
 * (duplicates included), only negative rules, a rule that is not `/…` or `!/…`,
 * an over-long or duplicate rule, and a rule another one ending in `*` already
 * covers (checked within the positive and the negative rules separately).
 */
const runWorkerFirstProblems = (rules: ReadonlyArray<unknown>): string[] => {
    if (rules.length === 0) {
        return ["assets.run_worker_first is an empty list, which wrangler refuses; remove it, or name at least one path"];
    }

    const problems: string[] = [];

    if (rules.length > MAX_RUN_WORKER_FIRST_RULES) {
        problems.push(
            `assets.run_worker_first has ${String(rules.length)} rules; Cloudflare accepts at most ${String(MAX_RUN_WORKER_FIRST_RULES)}, duplicates included`,
        );
    }

    const positive: string[] = [];
    const negative: string[] = [];

    for (const rule of rules) {
        if (typeof rule === "string" && rule.startsWith("/")) {
            positive.push(rule);
        } else if (typeof rule === "string" && rule.startsWith("!/")) {
            negative.push(rule);
        } else {
            problems.push(`assets.run_worker_first entry ${JSON.stringify(rule)} must be a path rule starting with "/" (or "!/" to exempt a path)`);
        }
    }

    if (positive.length === 0 && negative.length > 0) {
        problems.push("assets.run_worker_first has only negative (!/…) rules; wrangler needs at least one path that runs the Worker first");
    }

    problems.push(...groupProblems(positive), ...groupProblems(negative));

    return problems;
};

/** Why a route gets no rule, as a warning. */
const unroutableWarning = (route: string): string =>
    route.split("/").every((segment) => segment === "")
        ? `the route "${route}" is the site root; run_worker_first leaves it to the assets (index.html), so add "/" to run_worker_first yourself if the Worker should answer it`
        : `the route "${route}" starts with a parameter, so no run_worker_first rule names it without sending every path to the Worker; a matching file in the assets directory, or the not_found_handling fallback, answers instead`;

/**
 * The full rule list for `routes`: the reserved paths first, then each route's
 * rules, deduplicated, with every rule another one covers dropped (wrangler
 * refuses those), and sorted so the same routes always write the same list.
 * Rules past Cloudflare's caps are dropped and named in `warnings`.
 */
const planRunWorkerFirst = (routes: ReadonlyArray<string>): { rules: string[]; warnings: string[] } => {
    const warnings: string[] = [];
    const routeRules = new Set<string>();

    for (const route of routes) {
        const rules = workerPathRules(route);

        if (rules === undefined) {
            warnings.push(unroutableWarning(route));

            continue;
        }

        for (const rule of rules) {
            if (rule.length > MAX_RUN_WORKER_FIRST_RULE_LENGTH) {
                warnings.push(
                    `run_worker_first rule "${rule}" is longer than Cloudflare's ${String(MAX_RUN_WORKER_FIRST_RULE_LENGTH)} characters and was left out`,
                );
            } else {
                routeRules.add(rule);
            }
        }
    }

    const all = [...LUNORA_WORKER_FIRST_PATHS, ...routeRules];
    const kept = [...new Set(all)]
        .filter((rule) => !all.some((wider) => coveredBy(rule, wider)) && !LUNORA_WORKER_FIRST_PATHS.includes(rule))
        .toSorted((a, b) => a.localeCompare(b));
    const room = MAX_RUN_WORKER_FIRST_RULES - LUNORA_WORKER_FIRST_PATHS.length;

    if (kept.length > room) {
        warnings.push(
            `the routes need ${String(kept.length + LUNORA_WORKER_FIRST_PATHS.length)} run_worker_first rules and Cloudflare accepts ${String(MAX_RUN_WORKER_FIRST_RULES)}; ${kept
                .slice(room)
                .join(", ")} were left out`,
        );
    }

    return { rules: [...LUNORA_WORKER_FIRST_PATHS, ...kept.slice(0, room)], warnings };
};

/** Whether two rules match some path in common: equal, or one ending in `*` covers the other. */
const overlaps = (left: string, right: string): boolean => left === right || coveredBy(left, right) || coveredBy(right, left);

/**
 * The paths an authored `run_worker_first` leaves to the assets, so the caller
 * can say which ones and why: `missing` has no positive rule naming it, and
 * `excluded` maps each path a positive rule names to the `!/…` rules that take
 * part of it back (a negative rule wins over a positive one).
 */
const unroutedPaths = (runWorkerFirst: unknown, wanted: ReadonlyArray<string>): { excluded: Map<string, string[]>; missing: string[] } => {
    const excluded = new Map<string, string[]>();
    const missing: string[] = [];

    if (runWorkerFirst === true) {
        return { excluded, missing };
    }

    const rules = Array.isArray(runWorkerFirst) ? (runWorkerFirst as unknown[]).filter((rule): rule is string => typeof rule === "string") : [];
    const positive = rules.filter((rule) => rule.startsWith("/"));
    const negative = rules.filter((rule) => rule.startsWith("!/"));

    for (const path of wanted) {
        if (!positive.some((rule) => rule === path || coveredBy(path, rule))) {
            missing.push(path);

            continue;
        }

        const exclusions = negative.filter((rule) => overlaps(rule.slice(1), path));

        if (exclusions.length > 0) {
            excluded.set(path, exclusions);
        }
    }

    return { excluded, missing };
};

/** The warning for an authored `run_worker_first` that leaves some of `rules` to the assets, or `undefined` when it leaves none. */
const unroutedWarning = (current: unknown, label: string, rules: ReadonlyArray<string>): string | undefined => {
    const { excluded, missing } = unroutedPaths(current, rules);
    const notes: string[] = [];

    if (missing.length > 0) {
        notes.push(
            `${label} does not send ${missing.join(", ")} to the Worker first, so a matching file in the assets directory (or the SPA fallback) answers instead of Lunora — add ${missing.map((entry) => `"${entry}"`).join(", ")} to it`,
        );
    }

    for (const [path, exclusions] of excluded) {
        notes.push(
            `${label} sends ${path} to the Worker first, but ${exclusions.map((entry) => `"${entry}"`).join(", ")} takes part of it back to the assets — remove ${exclusions.length === 1 ? "that rule" : "those rules"} unless the Worker never serves the paths it names`,
        );
    }

    return notes.length === 0 ? undefined : notes.join("; ");
};

const sameRules = (left: unknown, right: ReadonlyArray<string> | undefined): boolean =>
    Array.isArray(left) && left.length === right?.length && left.every((rule, index) => rule === right[index]);

/** The rules recorded per scope in the manifest, or `{}` when nothing usable is recorded. */
const readOwnedRunWorkerFirst = (manifest: Manifest | undefined): OwnedRunWorkerFirst => {
    const recorded = manifest?.lunora?.[RUN_WORKER_FIRST_RECORD];

    if (!isPlainObject(recorded)) {
        return {};
    }

    return Object.fromEntries(
        Object.entries(recorded).filter((scope): scope is [string, string[]] => Array.isArray(scope[1]) && scope[1].every((rule) => typeof rule === "string")),
    );
};

/**
 * Why an SPA's absent `run_worker_first` stays absent, and how to opt in. Without
 * a list Cloudflare sends only an unmatched browser navigation to `index.html`
 * (compatibility date 2025-04-01 or later) and every other miss to the Worker; a
 * list turns that detection off, so every path it leaves out, a `fetch` included,
 * gets `index.html`. Lunora cannot see every Worker path (a computed auth
 * `basePath`, a route mounted on a Hono `httpRouter` directly), so it does not
 * trade the first failure for the second on the user's behalf.
 */
const spaWarning = (label: string, rules: ReadonlyArray<string>): string =>
    `${label} is not set, and Lunora does not write it under not_found_handling "single-page-application": a list would send every path it leaves out, fetches included, to index.html. ` +
    `Without one, a browser navigation to a Worker path (an OAuth callback, a link in an email) gets index.html instead of the Worker. ` +
    `To route those, set it yourself to ${JSON.stringify(rules)} plus any Worker path Lunora cannot see; Lunora then keeps your list and warns about paths it misses`;

/**
 * What reconcile does with one `assets` block: write or rewrite a
 * `run_worker_first` Lunora owns (absent, the list it recorded, or a value an
 * earlier version or template wrote), or warn about the paths an authored one
 * leaves to the assets. An absent one under the SPA fallback is left absent,
 * with a warning (see {@link spaWarning}).
 */
const reconcileScope = (
    current: unknown,
    notFoundHandling: unknown,
    label: string,
    rules: string[],
    recorded: string[] | undefined,
): { change: "added" | "updated" | undefined; owned: boolean; warning: string | undefined } => {
    if (current === undefined && notFoundHandling === "single-page-application") {
        return { change: undefined, owned: false, warning: spaWarning(label, rules) };
    }

    const lunoraWrote = current === undefined || sameRules(current, recorded) || LEGACY_WORKER_FIRST_VALUES.some((value) => sameRules(current, value));

    if (!lunoraWrote) {
        return { change: undefined, owned: false, warning: unroutedWarning(current, label, rules) };
    }

    if (sameRules(current, rules)) {
        return { change: undefined, owned: true, warning: undefined };
    }

    return { change: current === undefined ? "added" : "updated", owned: true, warning: undefined };
};

/**
 * Route the paths the Worker serves to it ahead of the assets: Lunora's reserved
 * paths plus the app's own routes (`workerRoutes`). Writes
 * `assets.run_worker_first` on every `assets` block (top level and
 * `env.<name>`) that does not set it, unless that block falls back to a single-page
 * app (see {@link spaWarning}), and rewrites a value Lunora wrote itself
 * (recorded in the manifest, or one an earlier version or template wrote) when
 * the routes change. A value the user wrote or edited is never rewritten; when it
 * leaves a path to the assets the step warns instead. The step's `record` stores
 * which values Lunora now owns, once the config is on disk.
 */
const reconcileAssetRouting = (text: string, parsed: WranglerShape, workerRoutes: ReadonlyArray<string>, manifest: Manifest | undefined): ReconcileStep => {
    const scopes: { assets: unknown; path: string[] }[] = [{ assets: parsed.assets, path: ["assets"] }];

    for (const [name, block] of Object.entries(parsed.env ?? {})) {
        if (isPlainObject(block)) {
            scopes.push({ assets: block["assets"], path: ["env", name, "assets"] });
        }
    }

    const plan = planRunWorkerFirst(workerRoutes);
    const recorded = readOwnedRunWorkerFirst(manifest);
    const owned: OwnedRunWorkerFirst = {};
    const step: Required<Omit<ReconcileStep, "record">> = { added: [], text, updated: [], warnings: [] };

    for (const { assets, path } of scopes.filter((scope) => isPlainObject(scope.assets))) {
        const scope = path.join(".");
        const block = assets as Record<string, unknown>;
        // An env's own `assets` block replaces the top-level one whole, so its fallback is read from the same block.
        const outcome = reconcileScope(block["run_worker_first"], block["not_found_handling"], `${scope}.run_worker_first`, plan.rules, recorded[scope]);

        if (outcome.owned) {
            owned[scope] = plan.rules;
        }

        if (outcome.warning !== undefined) {
            step.warnings.push(outcome.warning);
        }

        if (outcome.change !== undefined) {
            step.text = applyModify(step.text, [...path, "run_worker_first"], plan.rules);
            step[outcome.change].push(`${scope}.run_worker_first`);
        }
    }

    // The plan's own warnings concern `run_worker_first`, so a project with no assets block has nothing to hear.
    if (scopes.some((scope) => isPlainObject(scope.assets))) {
        step.warnings.unshift(...plan.warnings);
    }

    return {
        ...step,
        record: {
            consequence: "the next route change leaves run_worker_first as it is",
            key: RUN_WORKER_FIRST_RECORD,
            label: "run_worker_first rules",
            write: (current) => {
                recordManifestKey(current, RUN_WORKER_FIRST_RECORD, Object.keys(owned).length === 0 ? undefined : owned);
            },
        },
    };
};

export {
    LUNORA_WORKER_FIRST_PATHS,
    MAX_RUN_WORKER_FIRST_RULE_LENGTH,
    MAX_RUN_WORKER_FIRST_RULES,
    planRunWorkerFirst,
    reconcileAssetRouting,
    runWorkerFirstProblems,
    workerPathRules,
};
