/**
 * Remote-binding dev support (`CIRRUS_REMOTE=1`).
 *
 * When `cirrus dev` runs with `CIRRUS_REMOTE` set, the local worker should hit
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
 * config it reports which binding entries are eligible for remote mode. Only the
 * stateless storage bindings (D1, KV, R2) qualify; Durable Objects are never
 * remoted, because a Cirrus shard's authoritative state is its DO SQLite and CF
 * has no remote-DO mode — shards run locally while their data deps point at
 * production (the PLAN5 §5.3 boundary).
 *
 * {@link materializeRemoteWranglerConfig} writes a sibling temp config with
 * `"remote": true` injected onto each eligible binding, comment-preservingly, so
 * `cirrus dev` can point `wrangler dev --config` at it without ever mutating the
 * user's checked-in `wrangler.jsonc`.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { applyEdits, modify } from "jsonc-parser";

import join from "./path";
import { findWranglerFile, readWranglerJsonc } from "./wrangler-path";

const FORMATTING = { formattingOptions: { insertSpaces: true, tabSize: 4 } } as const;

/**
 * The wrangler binding arrays Cirrus can safely flip to remote mode in dev.
 * Each maps the top-level config key to a human label used in logs.
 *
 * Deliberately omits `durable_objects` (no CF remote-DO mode; shards stay
 * local), `vectorize`, `queues`, `services` and friends — the first increment
 * targets the three stateful stores VOID-TEARDOWN names (D1/KV/R2). Widening to
 * more binding kinds is a follow-up; the decision lives in one table.
 */
const REMOTE_ELIGIBLE_KEYS = {
    d1_databases: "D1",
    kv_namespaces: "KV",
    r2_buckets: "R2",
} as const;

type RemoteEligibleKey = keyof typeof REMOTE_ELIGIBLE_KEYS;

const REMOTE_ELIGIBLE_KEY_LIST = Object.keys(REMOTE_ELIGIBLE_KEYS) as RemoteEligibleKey[];

/** One binding entry we mark remote, with enough provenance to log + edit it. */
interface RemoteBindingPlan {
    /** The binding name as declared in the config (e.g. `"DB"`, `"FILES"`). */
    binding: string;
    /** Index of the entry within its config array — the jsonc edit path tail. */
    index: number;
    /** Short kind label for logging (`"D1"`, `"KV"`, `"R2"`). */
    kind: string;
    /** The wrangler config key the entry lives under. */
    section: RemoteEligibleKey;
}

/** The structural slice of a wrangler config the remote planner reads. */
interface RemoteWranglerShape {
    d1_databases?: ReadonlyArray<{ binding?: string; remote?: boolean } | null | undefined>;
    kv_namespaces?: ReadonlyArray<{ binding?: string; remote?: boolean } | null | undefined>;
    r2_buckets?: ReadonlyArray<{ binding?: string; remote?: boolean } | null | undefined>;
}

/**
 * Inspect a parsed wrangler config and list every D1/KV/R2 binding that should
 * be flipped to remote mode. Pure — no file-system access, no mutation. An
 * entry already carrying `"remote": true` is still reported (so logging is
 * complete) but the materializer's edit is a harmless no-op for it.
 */
const planRemoteBindings = (parsed: RemoteWranglerShape): RemoteBindingPlan[] => {
    const plans: RemoteBindingPlan[] = [];

    for (const section of REMOTE_ELIGIBLE_KEY_LIST) {
        const entries = parsed[section] ?? [];

        for (const [index, entry] of entries.entries()) {
            if (entry === null || entry === undefined) {
                continue;
            }

            plans.push({
                binding: typeof entry.binding === "string" ? entry.binding : `#${String(index)}`,
                index,
                kind: REMOTE_ELIGIBLE_KEYS[section],
                section,
            });
        }
    }

    return plans;
};

/** Apply one structural edit and return the rewritten text (mirrors reconcile-bindings). */
const applyModify = (text: string, path: ReadonlyArray<number | string>, value: unknown): string => {
    const edits = modify(text, [...path], value, FORMATTING);

    return edits.length > 0 ? applyEdits(text, edits) : text;
};

/**
 * Inject `"remote": true` onto each planned binding in the config `text`,
 * comment-preservingly via jsonc edits. Pure string→string; the edits target
 * disjoint array entries so applying them sequentially is safe.
 */
const injectRemoteFlags = (text: string, plans: ReadonlyArray<RemoteBindingPlan>): string => {
    let next = text;

    for (const plan of plans) {
        next = applyModify(next, [plan.section, plan.index, "remote"], true);
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

/** Filename component identifying a Cirrus-generated remote-dev config. */
const REMOTE_CONFIG_BASENAME = "wrangler.remote.jsonc";

/**
 * Produce a temporary wrangler config with `"remote": true` on every eligible
 * binding, so `cirrus dev` can run `wrangler dev --config &lt;temp>` against the
 * deployed D1/KV/R2 without touching the user's file.
 *
 * The temp file is written to an OS temp dir (not next to the source), and the
 * config's `main`/asset paths are left untouched — wrangler resolves a config's
 * relative paths against the **project root** it is invoked from, and
 * `cirrus dev` keeps running wrangler with the project as cwd, so the temp
 * location does not change path resolution. Returns `configPath: undefined`
 * (with a `reason`) for every fall-through case so the caller degrades to plain
 * local dev instead of failing.
 */
const materializeRemoteWranglerConfig = (options: MaterializeOptions): MaterializeResult => {
    if (!options.enabled) {
        return { enabled: false, remoteBindings: [] };
    }

    const wranglerPath = findWranglerFile(options.projectRoot);

    if (!wranglerPath) {
        return { enabled: true, reason: "wrangler.jsonc not found", remoteBindings: [] };
    }

    const { parsed, text } = readWranglerJsonc<RemoteWranglerShape>(wranglerPath);

    if (parsed === undefined) {
        return { enabled: true, reason: `failed to parse ${wranglerPath} as JSONC`, remoteBindings: [] };
    }

    const plans = planRemoteBindings(parsed);

    if (plans.length === 0) {
        return { enabled: true, reason: "no D1/KV/R2 bindings to proxy remotely", remoteBindings: [] };
    }

    const directory = mkdtempSync(join(tmpdir(), "cirrus-remote-"));
    const configPath = join(directory, REMOTE_CONFIG_BASENAME);

    writeFileSync(configPath, injectRemoteFlags(text, plans), "utf8");

    return { configPath, enabled: true, remoteBindings: plans };
};

/**
 * Parse a `CIRRUS_REMOTE` env value into the on/off decision. Truthy when set to
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

export type { MaterializeOptions, MaterializeResult, RemoteBindingPlan, RemoteWranglerShape };
export { injectRemoteFlags, isRemoteEnvEnabled, materializeRemoteWranglerConfig, planRemoteBindings, REMOTE_ELIGIBLE_KEYS };
