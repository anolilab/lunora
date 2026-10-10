/**
 * Remote-binding dev support (`LUNORA_REMOTE=1`).
 *
 * When `lunora dev` runs with `LUNORA_REMOTE` set, the local worker should hit
 * the project's **deployed** D1/KV/R2 instead of empty local-only resources —
 * so you debug against real data. wrangler 4 ships this natively: a binding
 * tagged `"remote": true` in the config is proxied to the deployed resource
 * during `wrangler dev`, keeping local iteration speed and breakpoint
 * debugging. We therefore lean entirely on the platform's remote-binding mode
 * rather than hand-rolling HTTP proxy shims (the approach VOID-TEARDOWN §4.5
 * sketches predates wrangler's native support).
 *
 * Two halves live here, both pure/file-system-local and unit-testable.
 *
 * {@link planRemoteBindings} is the decision layer: given a parsed wrangler
 * config it reports which binding entries are eligible for remote mode. The
 * stateless storage + service bindings whose wrangler schema accepts
 * `"remote": true` qualify (D1, KV, R2, Vectorize, Queue producers, Services,
 * AI, AI Search); Durable Objects are never remoted, because a Lunora shard's
 * authoritative state is its DO SQLite and CF has no remote-DO mode — shards run
 * locally while their data deps point at production (the PLAN5 §5.3 boundary).
 *
 * {@link materializeDevWranglerConfig} writes a sibling temp config with
 * `"remote": true` injected onto each eligible binding, comment-preservingly, so
 * `lunora dev` can point `wrangler dev --config` at it without ever mutating the
 * user's checked-in `wrangler.jsonc`. It returns a `cleanup` disposer so the caller
 * can remove the file when dev exits.
 */
import { applyModify } from "../jsonc-edit";
import { hasCloudflareCredentials } from "./credentials";
import { noopCleanup, withheldWorkersAi, writeDevConfig } from "./dev-config";
import { readManifest } from "./lunora-manifest";
import { ownedServiceBindings } from "./reconcile-services";
import { findWranglerFile, readWranglerJsonc } from "./wrangler-path";

/**
 * The wrangler config sections Lunora can safely flip to remote mode in dev,
 * each with the human label used in logs and the structural `shape` the entry
 * lives in.
 *
 * `"array"` is a top-level array of binding objects (`d1_databases`,
 * `kv_namespaces`, `r2_buckets`, `vectorize`, `services`). `"producers"` is
 * `queues.producers[]` — consumers are NOT remoted (their schema has no `remote`
 * field) and the edit path is two levels deep. `"object"` is a single binding
 * object, not an array (`ai`), whose edit path targets the section key directly.
 *
 * Every kind here was confirmed against `wrangler/config-schema.json`: the
 * entry's schema declares a `remote` property. Deliberately omits
 * `durable_objects` (no CF remote-DO mode; shards stay local) and sections whose
 * schema has no `remote` field (`hyperdrive`, `analytics_engine_datasets`,
 * `secrets_store_secrets`, queue consumers, …). Widening further is a one-line
 * table edit.
 */
const REMOTE_ELIGIBLE_KEYS = {
    ai: { label: "AI", shape: "object" },
    // Both AI Search sections are remote in plain `wrangler dev` already (wrangler
    // rates them "never has a local simulator"); tagging them here only silences
    // its "may incur usage charges" warning under `LUNORA_REMOTE`.
    ai_search: { label: "AI Search", shape: "array" },
    ai_search_namespaces: { label: "AI Search namespace", shape: "array" },
    // Analytics SQL is likewise remote-only in plain `wrangler dev` (never a local
    // simulator, wrangler >= 4.145.0); tagging it only silences the usage warning.
    analytics: { label: "Analytics SQL", shape: "object" },
    d1_databases: { label: "D1", shape: "array" },
    kv_namespaces: { label: "KV", shape: "array" },
    queues: { label: "Queue", shape: "producers" },
    r2_buckets: { label: "R2", shape: "array" },
    services: { label: "Service", shape: "array" },
    vectorize: { label: "Vectorize", shape: "array" },
} as const;

type RemoteEligibleKey = keyof typeof REMOTE_ELIGIBLE_KEYS;

/**
 * The eligible sections of one structural `shape` — a mapped key type over the
 * table, so a section narrowed by {@link hasShape} indexes
 * {@link RemoteWranglerShape} at its real type, without a cast.
 */
type RemoteSectionOfShape<Shape> = {
    [Key in RemoteEligibleKey]: (typeof REMOTE_ELIGIBLE_KEYS)[Key]["shape"] extends Shape ? Key : never;
}[RemoteEligibleKey];

const REMOTE_ELIGIBLE_KEY_LIST = Object.keys(REMOTE_ELIGIBLE_KEYS) as RemoteEligibleKey[];

/** One binding object as it appears in any eligible section. */
interface BindingEntry {
    binding?: string;
    remote?: boolean;
}

/** One binding entry we mark remote, with enough provenance to log + edit it. */
interface RemoteBindingPlan {
    /** The binding name as declared in the config (e.g. `"DB"`, `"FILES"`). */
    binding: string;
    /** Short kind label for logging (`"D1"`, `"KV"`, `"R2"`, `"Vectorize"`, …). */
    kind: string;

    /**
     * The jsonc edit path within {@link RemoteBindingPlan.section}, relative to
     * the section key: `[index]` for an `"array"` section, `["producers", index]`
     * for a queue producer, or `[]` for the single-object `ai` section. The
     * materializer prepends the section key and appends `"remote"`.
     */
    path: ReadonlyArray<number | string>;
    /** The wrangler config key the entry lives under. */
    section: RemoteEligibleKey;
}

/** The structural slice of a wrangler config the remote planner reads. */
interface RemoteWranglerShape {
    ai?: BindingEntry | null;
    ai_search?: ReadonlyArray<BindingEntry | null | undefined>;
    ai_search_namespaces?: ReadonlyArray<BindingEntry | null | undefined>;
    analytics?: BindingEntry | null;
    d1_databases?: ReadonlyArray<BindingEntry | null | undefined>;
    kv_namespaces?: ReadonlyArray<BindingEntry | null | undefined>;
    queues?: { producers?: ReadonlyArray<BindingEntry | null | undefined> } | null;
    r2_buckets?: ReadonlyArray<BindingEntry | null | undefined>;
    services?: ReadonlyArray<BindingEntry | null | undefined>;
    vectorize?: ReadonlyArray<BindingEntry | null | undefined>;
}

/** Derive the log/plan name for an entry: its declared `binding`, else a positional fallback. */
const entryName = (entry: BindingEntry, fallback: string): string => (typeof entry.binding === "string" ? entry.binding : fallback);

/**
 * Collect remote plans from an array of binding entries, each plan's edit path
 * being `[...pathPrefix, index]`. Used for the flat `"array"` sections (empty
 * prefix) and for `queues.producers` (prefix `["producers"]`).
 */
const planArrayEntries = (
    section: RemoteEligibleKey,
    entries: ReadonlyArray<BindingEntry | null | undefined>,
    kind: string,
    pathPrefix: ReadonlyArray<number | string>,
): RemoteBindingPlan[] => {
    const plans: RemoteBindingPlan[] = [];

    for (const [index, entry] of entries.entries()) {
        if (entry === null || entry === undefined) {
            continue;
        }

        plans.push({ binding: entryName(entry, `#${String(index)}`), kind, path: [...pathPrefix, index], section });
    }

    return plans;
};

/** Narrow `section` to the eligible sections of `shape`. */
const hasShape = <Shape extends (typeof REMOTE_ELIGIBLE_KEYS)[RemoteEligibleKey]["shape"]>(
    section: RemoteEligibleKey,
    shape: Shape,
): section is RemoteSectionOfShape<Shape> => REMOTE_ELIGIBLE_KEYS[section].shape === shape;

/** Plans for one eligible section, dispatched on its declared structural shape. */
const planSection = (section: RemoteEligibleKey, parsed: RemoteWranglerShape): RemoteBindingPlan[] => {
    const { label } = REMOTE_ELIGIBLE_KEYS[section];

    if (hasShape(section, "array")) {
        return planArrayEntries(section, parsed[section] ?? [], label, []);
    }

    if (hasShape(section, "object")) {
        // Single-object section (`ai`, `analytics`): one binding, edit path is the section key itself.
        const entry = parsed[section];

        return entry === null || entry === undefined ? [] : [{ binding: entryName(entry, section), kind: label, path: [], section }];
    }

    return planArrayEntries(section, parsed.queues?.producers ?? [], label, ["producers"]);
};

/**
 * Inspect a parsed wrangler config and list every eligible binding that should
 * be flipped to remote mode. Pure — no file-system access, no mutation. An
 * entry already carrying `"remote": true` is still reported (so logging is
 * complete) but the materializer's edit is a harmless no-op for it.
 */
const planRemoteBindings = (parsed: RemoteWranglerShape): RemoteBindingPlan[] => REMOTE_ELIGIBLE_KEY_LIST.flatMap((section) => planSection(section, parsed));

/**
 * Inject `"remote": true` onto each planned binding in the config `text`,
 * comment-preservingly via jsonc edits. Pure string→string; the edits target
 * disjoint entries so applying them sequentially is safe. The edit path is
 * `[section, ...plan.path, "remote"]`, which resolves to the array element, the
 * `queues.producers[i]` entry, or the single `ai` object as the plan demands.
 */
const injectRemoteFlags = (text: string, plans: ReadonlyArray<RemoteBindingPlan>): string => {
    let next = text;

    for (const plan of plans) {
        next = applyModify(next, [plan.section, ...plan.path, "remote"], true);
    }

    return next;
};

interface MaterializeDevOptions {
    /** Whether wrangler can authenticate; defaults to a probe of `projectRoot`. */
    hasCredentials?: () => boolean;
    projectRoot: string;
    /** Proxy the eligible bindings to the deployed resources (`--remote` / `LUNORA_REMOTE`). Off, only the logged-out `ai` withholding applies. */
    remote: boolean;
}

interface MaterializeDevResult {
    /** Removes the temp config. Always safe to call: idempotent, and a no-op when nothing was written. */
    cleanup: () => void;
    /** The temp config to pass to `wrangler dev --config`, or `undefined` to run the user's file unchanged. */
    configPath?: string;
    /** Why remote mode produced no temp config, for the dev log. Only set when nothing was written. */
    reason?: string;
    /** The bindings flipped to remote, for the dev banner. */
    remoteBindings: RemoteBindingPlan[];
    /** The `ai` binding name left out for lack of Cloudflare credentials, for the dev warning. */
    withheld: string[];
}

/**
 * Write the temp wrangler config a dev session runs with: the user's file with any
 * eligible bindings flipped to `"remote": true` (when `remote` is set), and the
 * `ai` binding removed when the session has no Cloudflare login. See `dev-config.ts`
 * for why the `ai` removal exists.
 *
 * The temp file sits beside the source `wrangler.jsonc`, not in an OS temp dir,
 * because wrangler resolves a config's relative `main`/`assets`/`migrations_dir`
 * paths against the config file's own directory. Returns no `configPath` when there
 * is nothing to change, so the caller runs the user's file unchanged.
 */
const materializeDevWranglerConfig = (options: MaterializeDevOptions): MaterializeDevResult => {
    const unchanged = (reason?: string): MaterializeDevResult => {
        return { cleanup: noopCleanup, reason, remoteBindings: [], withheld: [] };
    };
    const wranglerPath = findWranglerFile(options.projectRoot);

    if (!wranglerPath) {
        return unchanged("wrangler.jsonc not found");
    }

    const { parsed, text } = readWranglerJsonc<RemoteWranglerShape>(wranglerPath);

    if (parsed === undefined) {
        return unchanged(`failed to parse ${wranglerPath} as JSONC`);
    }

    // A Lunora-owned service binding (plan 457) runs locally beside the app in the
    // same dev session, so remoting it would call the deployed Worker instead.
    const localServices = ownedServiceBindings(readManifest(options.projectRoot));
    const plans = options.remote ? planRemoteBindings(parsed).filter((plan) => plan.section !== "services" || !localServices.has(plan.binding)) : [];
    const withheldBinding = withheldWorkersAi(parsed.ai, options.hasCredentials ?? (() => hasCloudflareCredentials({ projectRoot: options.projectRoot })));
    const withheld = withheldBinding === undefined ? [] : [withheldBinding];
    const remoteBindings = withheldBinding === undefined ? plans : plans.filter((plan) => plan.section !== "ai");

    if (remoteBindings.length === 0 && withheld.length === 0) {
        return unchanged(options.remote ? "no remote-eligible bindings to proxy" : undefined);
    }

    const withoutAi = withheld.length > 0 ? applyModify(text, ["ai"], undefined) : text;
    const contents = remoteBindings.length > 0 ? injectRemoteFlags(withoutAi, remoteBindings) : withoutAi;
    const written = writeDevConfig(options.projectRoot, "dev", contents);

    return { cleanup: written.cleanup, configPath: written.configPath, remoteBindings, withheld };
};

/**
 * Parse a `LUNORA_REMOTE` env value into the on/off decision. Truthy when set to
 * `"1"` or `"true"` (case-insensitive); anything else — unset, `"0"`, `"false"`,
 * empty — is off. Mirrors the `"1" | "true"` convention used across the runtime.
 */
const isRemoteEnvEnabled = (value: string | undefined): boolean => {
    if (value === undefined) {
        return false;
    }

    const normalized = value.trim().toLowerCase();

    return normalized === "1" || normalized === "true";
};

/** The three inputs that can switch remote-binding dev on, in precedence order. */
interface RemoteEnableInputs {
    /**
     * The `remote` preference from `lunora.config.*` (the lowest-priority signal).
     * `undefined` means "no project preference"; an explicit `false` here loses
     * to neither the flag nor the env when those are absent — it just stays off.
     */
    configPreference?: boolean;
    /** The raw `LUNORA_REMOTE` env value (parsed with {@link isRemoteEnvEnabled}). */
    envValue?: string;
    /** The explicit `--remote` CLI flag — `true` when passed, `undefined`/`false` otherwise. */
    flag?: boolean;
}

/**
 * Resolve whether remote-binding dev is on, with a clear precedence:
 *
 * 1. an explicit `--remote` flag (highest — a deliberate per-invocation choice),
 * 2. then `LUNORA_REMOTE` in the environment,
 * 3. then the `remote` key in `lunora.config.*` (lowest — a project default).
 *
 * The flag and env are one-directional (they can only turn remote *on*); only
 * the config preference carries a meaningful `false`, and it applies solely when
 * neither stronger signal is present. So a project that sets `"remote": false`
 * is still overridable per-run by `--remote` or `LUNORA_REMOTE=1`.
 */
const resolveRemoteEnabled = (inputs: RemoteEnableInputs): boolean => {
    if (inputs.flag === true) {
        return true;
    }

    if (isRemoteEnvEnabled(inputs.envValue)) {
        return true;
    }

    return inputs.configPreference ?? false;
};

export type { MaterializeDevOptions, MaterializeDevResult, RemoteBindingPlan, RemoteEnableInputs, RemoteWranglerShape };
export { injectRemoteFlags, isRemoteEnvEnabled, materializeDevWranglerConfig, planRemoteBindings, REMOTE_ELIGIBLE_KEYS, resolveRemoteEnabled };
