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
 * AI); Durable Objects are never remoted, because a Lunora shard's
 * authoritative state is its DO SQLite and CF has no remote-DO mode — shards run
 * locally while their data deps point at production (the PLAN5 §5.3 boundary).
 *
 * {@link materializeRemoteWranglerConfig} writes a sibling temp config with
 * `"remote": true` injected onto each eligible binding, comment-preservingly, so
 * `lunora dev` can point `wrangler dev --config` at it without ever mutating the
 * user's checked-in `wrangler.jsonc`. It returns a {@link MaterializeResult.cleanup}
 * disposer so the caller can unlink the generated temp dir when dev exits.
 */
import { rmSync, writeFileSync } from "node:fs";

import { applyModify } from "../jsonc-edit";
import join from "../path";
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
    d1_databases: { label: "D1", shape: "array" },
    kv_namespaces: { label: "KV", shape: "array" },
    queues: { label: "Queue", shape: "producers" },
    r2_buckets: { label: "R2", shape: "array" },
    services: { label: "Service", shape: "array" },
    vectorize: { label: "Vectorize", shape: "array" },
} as const;

type RemoteEligibleKey = keyof typeof REMOTE_ELIGIBLE_KEYS;

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

/** Plans for one eligible section, dispatched on its declared structural shape. */
const planSection = (section: RemoteEligibleKey, parsed: RemoteWranglerShape): RemoteBindingPlan[] => {
    const { label, shape } = REMOTE_ELIGIBLE_KEYS[section];

    if (shape === "array") {
        const entries = (parsed[section] as ReadonlyArray<BindingEntry | null | undefined> | undefined) ?? [];

        return planArrayEntries(section, entries, label, []);
    }

    if (shape === "producers") {
        return planArrayEntries(section, parsed.queues?.producers ?? [], label, ["producers"]);
    }

    // Single-object section (`ai`): one binding, edit path is the section key itself.
    const entry = parsed.ai;

    return entry === null || entry === undefined ? [] : [{ binding: entryName(entry, section), kind: label, path: [], section }];
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

interface MaterializeOptions {
    /** When `false`, the call is a no-op (returns `enabled: false`). */
    enabled: boolean;
    projectRoot: string;
}

interface MaterializeResult {
    /**
     * Removes the generated temp config file. Always present and always safe to
     * call: it is idempotent, a no-op when nothing was written (disabled /
     * fall-through cases), and never throws if the path is already gone. The dev
     * command calls this on every exit path (normal, signal, error).
     */
    cleanup: () => void;

    /**
     * Absolute path to the generated temp config to pass to
     * `wrangler dev --config`. `undefined` when remote mode is disabled, no
     * wrangler config was found, it failed to parse, or it declared no eligible
     * binding (nothing to remote — run plain local dev).
     */
    configPath?: string;
    /** Whether remote mode was requested at all. */
    enabled: boolean;
    /** Why no temp config was produced, for logging (only set when none was). */
    reason?: string;
    /** The bindings flipped to remote, for the dev banner. */
    remoteBindings: RemoteBindingPlan[];
}

/** A disposer that does nothing — the cleanup for every fall-through (no temp file written). */
const noopCleanup = (): void => {};

/**
 * Build an idempotent disposer that removes the generated temp config file.
 * Guards against a double call (the flag) and a missing path (`force: true` +
 * try/catch), so the dev command can wire it onto multiple exit paths without
 * ever crashing the shutdown.
 */
const createCleanup = (path: string): (() => void) => {
    let done = false;

    return () => {
        if (done) {
            return;
        }

        done = true;

        try {
            rmSync(path, { force: true, recursive: true });
        } catch {
            /* already gone / unremovable — nothing actionable on shutdown */
        }
    };
};

/**
 * Filename for a Lunora-generated remote-dev config. A dotfile (less likely to
 * be committed / shown), per-process-unique so concurrent `lunora dev` runs on
 * one project don't clobber each other; the cleanup disposer unlinks it on exit.
 */
const remoteConfigBasename = (): string => `.wrangler.lunora-remote.${String(process.pid)}.jsonc`;

/**
 * Produce a temporary wrangler config with `"remote": true` on every eligible
 * binding, so `lunora dev` can run `wrangler dev --config <temp>` against the
 * deployed D1/KV/R2 without touching the user's file.
 *
 * The temp file is written as a sibling of the source `wrangler.jsonc` (in the
 * project root), NOT an OS temp dir: wrangler resolves a config's relative paths
 * (`main`, `assets`, `migrations_dir`, …) against the **config file's own
 * directory**, so a temp config in `/tmp` would make wrangler look for
 * `/tmp/src/server.ts` and fail to start the worker. Keeping it beside the real
 * config preserves those relative paths. Returns `configPath: undefined` (with a
 * `reason`) for every fall-through case so the caller degrades to plain local
 * dev instead of failing.
 */
const materializeRemoteWranglerConfig = (options: MaterializeOptions): MaterializeResult => {
    if (!options.enabled) {
        return { cleanup: noopCleanup, enabled: false, remoteBindings: [] };
    }

    const wranglerPath = findWranglerFile(options.projectRoot);

    if (!wranglerPath) {
        return { cleanup: noopCleanup, enabled: true, reason: "wrangler.jsonc not found", remoteBindings: [] };
    }

    const { parsed, text } = readWranglerJsonc<RemoteWranglerShape>(wranglerPath);

    if (parsed === undefined) {
        return { cleanup: noopCleanup, enabled: true, reason: `failed to parse ${wranglerPath} as JSONC`, remoteBindings: [] };
    }

    const plans = planRemoteBindings(parsed);

    if (plans.length === 0) {
        return { cleanup: noopCleanup, enabled: true, reason: "no remote-eligible bindings to proxy", remoteBindings: [] };
    }

    // Sibling of the source config (same directory) so wrangler resolves the
    // config's relative `main`/`assets`/`migrations_dir` paths correctly.
    const configPath = join(options.projectRoot, remoteConfigBasename());

    writeFileSync(configPath, injectRemoteFlags(text, plans), "utf8");

    return { cleanup: createCleanup(configPath), configPath, enabled: true, remoteBindings: plans };
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
     * The `remote` preference from `lunora.json` (the lowest-priority signal).
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
 * 3. then the `remote` key in `lunora.json` (lowest — a project default).
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

export type { MaterializeOptions, MaterializeResult, RemoteBindingPlan, RemoteEnableInputs, RemoteWranglerShape };
export { injectRemoteFlags, isRemoteEnvEnabled, materializeRemoteWranglerConfig, planRemoteBindings, REMOTE_ELIGIBLE_KEYS, resolveRemoteEnabled };
