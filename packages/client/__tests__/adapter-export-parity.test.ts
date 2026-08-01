import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Cross-adapter export-surface parity for the five framework ports (React,
 * Vue, Solid, Svelte, Angular). It lives here — in `@lunora/client`, not in
 * any one adapter — because `@lunora/client` is the shared core all five
 * depend on and is the non-drifting counterexample this test generalizes
 * from: `@lunora/client/pagination` is imported by every adapter's paginated
 * wrapper and has produced zero parity findings across every audit wave, in
 * contrast to auth-ui's orphaned controllers or the per-adapter `document`/SSR
 * guard gaps. Declaring the required surface once and asserting it here turns
 * "some adapter quietly lost a feature" from an audit finding into a red test.
 *
 * ## Reading this manifest
 *
 * The naming convention is NOT shared across adapters, by design: React and
 * Vue use `use*` (their host framework's idiom), Solid uses `create*`
 * (`createSignal`'s convention), and Svelte/Angular export bare nouns (a
 * store/signal, not a hook-shaped function). So {@link REQUIRED_SURFACE} maps
 * each feature to the actual per-adapter export name rather than asserting a
 * single literal name everywhere — that would be false parity, flagging
 * Solid's `createQuery` as a "gap" next to React's `useQuery` when nothing is
 * actually missing.
 *
 * A feature is checked against each adapter's public barrel (`src/index.ts`)
 * by default. `upload` is the one exception: React barrels it into `index.ts`
 * in addition to its own subpath, but Vue/Solid/Svelte only ever exposed it
 * as the `./upload` subpath (`src/upload.ts`) — never re-exported from the
 * barrel — so this manifest points at that file directly for every adapter
 * rather than manufacturing a barrel gap that was never real.
 *
 * A `{ gap: "…" }` entry is a genuine absence: the export does not exist
 * anywhere in that adapter today. The reason says whether it's a tracked
 * follow-up or a structural non-fit (see `authGates` for Svelte/Angular,
 * which have no JSX-like component model to gate with).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_ROOT = resolve(HERE, "..", "..");

const ADAPTER_NAMES = ["react", "vue", "solid", "svelte", "angular"] as const;

type AdapterName = (typeof ADAPTER_NAMES)[number];

const ADAPTER_SRC: Record<AdapterName, string> = Object.fromEntries(ADAPTER_NAMES.map((name) => [name, join(PACKAGES_ROOT, name, "src")])) as Record<
    AdapterName,
    string
>;

interface Export {
    /** File relative to the adapter's `src/` dir; defaults to `index.ts` (the public barrel). */
    module?: string;
    /** The exported symbol name (after `as`, if aliased). */
    name: string;
}

interface Gap {
    gap: string;
}

const isGap = (requirement: Export | Gap): requirement is Gap => "gap" in requirement;

type Requirement = Export | Gap;

const EXPORT_BLOCK_RE = /export\s*\{([^}]*)\}/g;
const AS_ALIAS_RE = /\bas\s+([A-Za-z_$][\w$]*)\s*$/;

/**
 * Required export surface, per feature, per adapter. Add a feature here when
 * it ships in more than one adapter — the whole point is catching the next
 * one that doesn't.
 */
const REQUIRED_SURFACE: Record<string, Record<AdapterName, Requirement>> = {
    agent: {
        angular: { name: "agent" },
        react: { name: "useAgent" },
        solid: { name: "createAgent" },
        svelte: { name: "agent" },
        vue: { name: "useAgent" },
    },
    agentChat: {
        angular: { name: "agentChat" },
        react: { name: "useAgentChat" },
        solid: { name: "createAgentChat" },
        svelte: { name: "agentChat" },
        vue: { name: "useAgentChat" },
    },
    agentState: {
        angular: { name: "agentState" },
        react: { name: "useAgentState" },
        solid: { name: "createAgentState" },
        svelte: { name: "agentState" },
        vue: { name: "useAgentState" },
    },
    agentToolEvents: {
        angular: { name: "agentToolEvents" },
        react: { name: "useAgentToolEvents" },
        solid: { name: "createAgentToolEvents" },
        svelte: { name: "agentToolEvents" },
        vue: { name: "useAgentToolEvents" },
    },
    auth: {
        angular: { name: "auth" },
        react: { name: "useAuth" },
        solid: { name: "createAuth" },
        svelte: { name: "auth" },
        vue: { name: "useAuth" },
    },
    // Authenticated/AuthLoading/Unauthenticated gate COMPONENTS. Svelte and
    // Angular have no JSX-like "render this subtree conditionally" component
    // primitive to build these from — a Svelte/Angular consumer gates the
    // template directly off the `auth`/`auth()` store-or-signal's fields
    // (`{#if $auth.authenticated}`, `@if (auth().authenticated)`). That's a
    // real framework-shape difference, not a missing port: nothing here would
    // be a component, it would be a documentation pattern.
    authGates: {
        angular: { gap: "no JSX-like component model to build Authenticated/AuthLoading/Unauthenticated from — gate templates off the auth() signal directly" },
        react: { name: "Authenticated" },
        solid: { name: "Authenticated" },
        svelte: { gap: "no JSX-like component model to build Authenticated/AuthLoading/Unauthenticated from — gate templates off the auth store directly" },
        vue: { name: "Authenticated" },
    },
    connectionStatus: {
        angular: { name: "connectionStatus" },
        react: { name: "useConnectionStatus" },
        solid: { name: "createConnectionStatus" },
        svelte: { name: "connectionStatus" },
        vue: { name: "useConnectionStatus" },
    },
    flag: {
        angular: { name: "flag" },
        react: { name: "useFlag" },
        solid: { name: "createFlag" },
        svelte: { name: "flag" },
        vue: { name: "useFlag" },
    },
    flags: {
        angular: { name: "flags" },
        react: { name: "useFlags" },
        solid: { name: "createFlags" },
        svelte: { name: "flags" },
        vue: { name: "useFlags" },
    },
    // The SSE-style HTTP-stream hook. Shipped for React only so far — nobody
    // has ported it. This is a real, still-open gap (not a framework-shape
    // difference like authGates), tracked separately from this spike; see
    // plan 231 for adapter-drift follow-ups.
    httpStream: {
        angular: { gap: "not yet ported — React-only today; see plan 231" },
        react: { name: "useHttpStream" },
        solid: { gap: "not yet ported — React-only today; see plan 231" },
        svelte: { gap: "not yet ported — React-only today; see plan 231" },
        vue: { gap: "not yet ported — React-only today; see plan 231" },
    },
    hydratePreloaded: {
        angular: { name: "hydratePreloaded" },
        react: { name: "hydratePreloaded" },
        solid: { name: "hydratePreloaded" },
        svelte: { name: "hydratePreloaded" },
        vue: { name: "hydratePreloaded" },
    },
    infiniteQuery: {
        angular: { name: "infiniteQuery" },
        react: { name: "useInfiniteQuery" },
        solid: { name: "createInfiniteQuery" },
        svelte: { name: "infiniteQuery" },
        vue: { name: "useInfiniteQuery" },
    },
    // The client-access primitive: read/inject the live `LunoraClient` a
    // provider set up. Named differently everywhere on purpose — Svelte has
    // no DI/context-consumer hook shape, so it's a plain getter.
    lunoraClient: {
        angular: { name: "injectLunoraClient" },
        react: { name: "useLunora" },
        solid: { name: "useLunora" },
        svelte: { name: "getLunoraClient" },
        vue: { name: "useLunora" },
    },
    mutation: {
        angular: { name: "mutate" },
        react: { name: "useMutation" },
        solid: { name: "createMutation" },
        svelte: { name: "mutation" },
        vue: { name: "useMutation" },
    },
    mutator: {
        angular: { name: "mutator" },
        react: { name: "useMutator" },
        solid: { name: "createMutator" },
        svelte: { name: "mutator" },
        vue: { name: "useMutator" },
    },
    paginatedQuery: {
        angular: { name: "paginatedQuery" },
        react: { name: "usePaginatedQuery" },
        solid: { name: "createPaginatedQuery" },
        svelte: { name: "paginatedQuery" },
        vue: { name: "usePaginatedQuery" },
    },
    presence: {
        angular: { name: "presence" },
        react: { name: "usePresence" },
        solid: { name: "createPresence" },
        svelte: { name: "presence" },
        vue: { name: "usePresence" },
    },
    query: {
        angular: { name: "liveQuery" },
        react: { name: "useQuery" },
        solid: { name: "createQuery" },
        svelte: { name: "query" },
        vue: { name: "useQuery" },
    },
    rateLimit: {
        angular: { name: "rateLimit" },
        react: { name: "useRateLimit" },
        solid: { name: "createRateLimit" },
        svelte: { name: "rateLimit" },
        vue: { name: "useRateLimit" },
    },
    stream: {
        angular: { name: "stream" },
        react: { name: "useStream" },
        solid: { name: "createStream" },
        svelte: { name: "stream" },
        vue: { name: "useStream" },
    },
    subscription: {
        angular: { name: "subscription" },
        react: { name: "useSubscription" },
        solid: { name: "createSubscription" },
        svelte: { name: "subscription" },
        vue: { name: "useSubscription" },
    },
    // Chunked/multipart/TUS/paste file upload. Vue/Solid/Svelte only ever
    // shipped this as the `./upload` subpath (`src/upload.ts`), never
    // barreled into `index.ts` — see the file header. Angular has neither the
    // subpath nor the file: a real, still-open gap (plan 233's cited
    // evidence), not a naming difference.
    upload: {
        angular: {
            gap: "no upload.ts and no ./upload subpath — chunked/multipart/TUS/paste upload was never ported; plan 233 evidence, still open on this base",
        },
        react: { module: "upload.ts", name: "useUpload" },
        solid: { module: "upload.ts", name: "createUpload" },
        svelte: { module: "upload.ts", name: "createUpload" },
        vue: { module: "upload.ts", name: "useUpload" },
    },
    voiceAgent: {
        angular: { name: "voiceAgent" },
        react: { name: "useVoiceAgent" },
        solid: { name: "createVoiceAgent" },
        svelte: { name: "voiceAgent" },
        vue: { name: "useVoiceAgent" },
    },
};

/**
 * Per-adapter opt-outs: a feature this adapter is not required to carry at
 * all, with why. (Currently unused — every feature above applies to every
 * adapter, with per-feature `gap` entries covering the exceptions. Kept as an
 * escape hatch: a feature that turns out to be legitimately inapplicable to
 * one adapter's programming model belongs here, annotated, rather than forcing
 * a `gap` entry that reads like an open bug.)
 */
const ADAPTER_OPT_OUTS: Partial<Record<AdapterName, Partial<Record<keyof typeof REQUIRED_SURFACE, string>>>> = {};

/** Every named export in `file`, resolving `export { default as X }` to `X`. */
const namedExportsOf = (file: string): Set<string> => {
    const source = readFileSync(file, "utf8");
    const names = new Set<string>();

    EXPORT_BLOCK_RE.lastIndex = 0;

    let match: RegExpExecArray | null = EXPORT_BLOCK_RE.exec(source);

    while (match !== null) {
        for (const raw of (match[1] ?? "").split(",")) {
            const spec = raw.trim();

            if (!spec) {
                continue;
            }

            const asMatch = AS_ALIAS_RE.exec(spec);
            const name = asMatch ? asMatch[1] : spec;

            if (name) {
                names.add(name);
            }
        }

        match = EXPORT_BLOCK_RE.exec(source);
    }

    return names;
};

interface Verdict {
    message: string;
    ok: boolean;
}

/**
 * Resolve a single (feature, adapter) cell to a pass/fail verdict. Kept out of
 * the `it` body (and so out of `expect`) so the three branches — opt-out, gap,
 * real check — never put a conditional around `expect` itself; the test below
 * makes exactly one unconditional assertion per cell.
 */
const verdictFor = (feature: string, byAdapter: Record<AdapterName, Requirement>, adapter: AdapterName): Verdict => {
    const optOutReason = ADAPTER_OPT_OUTS[adapter]?.[feature];

    if (optOutReason !== undefined) {
        return { message: `opted out: ${optOutReason}`, ok: optOutReason.length > 0 };
    }

    const requirement = byAdapter[adapter];

    if (isGap(requirement)) {
        // A `gap` entry must still say why — no silent absences.
        return { message: `${feature}/${adapter} is on the gap list with an empty reason — every gap needs one`, ok: requirement.gap.length > 0 };
    }

    const modulePath = join(ADAPTER_SRC[adapter], requirement.module ?? "index.ts");

    let exported: Set<string> | undefined;

    try {
        exported = namedExportsOf(modulePath);
    } catch {
        exported = undefined;
    }

    if (exported === undefined) {
        return {
            message:
                `${feature}: expected @lunora/${adapter} to export "${requirement.name}" from ` +
                `${requirement.module ?? "index.ts"}, but that file doesn't exist. Either the module moved ` +
                `(update REQUIRED_SURFACE) or this is a real gap (add a { gap: "…" } entry with a reason).`,
            ok: false,
        };
    }

    return {
        message:
            `${feature}: @lunora/${adapter} does not export "${requirement.name}" from ` +
            `${requirement.module ?? "index.ts"}. If this was intentionally removed or renamed, update ` +
            `REQUIRED_SURFACE; if it's a real regression, restore the export.`,
        ok: exported.has(requirement.name),
    };
};

const featureEntries = Object.entries(REQUIRED_SURFACE).toSorted(([a], [b]) => a.localeCompare(b));

describe("adapter export-surface parity (react, vue, solid, svelte, angular)", () => {
    it("declares a non-trivial manifest", () => {
        expect.assertions(1);

        expect(featureEntries.length).toBeGreaterThan(15);
    });

    describe.each(featureEntries)("%s", (feature, byAdapter) => {
        it.each(ADAPTER_NAMES)("%s carries it, has a documented gap, or is opted out", (adapter) => {
            expect.assertions(1);

            const verdict = verdictFor(feature, byAdapter, adapter);

            expect(verdict.ok, verdict.message).toBe(true);
        });
    });
});
