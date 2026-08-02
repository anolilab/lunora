import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { namedValueExportsOf } from "./lib/named-exports";

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
 * which have no JSX-like component model to gate with). Every gap also
 * carries the `name` (and, when it differs from `index.ts`, the `module`) it
 * is gapping, following the same per-adapter naming convention as a real
 * `Export` entry would — so the check can assert that name is still absent.
 * When a gap is later filled, that assertion is what turns red: the whole
 * point is that a stale gap entry does not get to stay green forever just
 * because nobody remembered to delete it (see plan 233 §5.2).
 *
 * `upload`'s adapters also carry a `subpath`: the feature's real contract is
 * the `./upload` package export (`import … from "@lunora/vue/upload"`), not
 * merely the existence of `src/upload.ts`, so the manifest checks the
 * adapter's `package.json` `exports` map for it too.
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

    /**
     * When the feature's real contract is a package-export subpath (e.g.
     * `./upload`), not merely a file on disk — the `exports` map key the
     * adapter's `package.json` must carry, checked in addition to `name`.
     */
    subpath?: string;
}

interface Gap {
    gap: string;
    /** File relative to the adapter's `src/` dir this would live in if ported; defaults to `index.ts`, same as `Export.module`. */
    module?: string;

    /**
     * The name this adapter would export the feature under, following its
     * own naming convention, if it existed — checked to still be ABSENT.
     * When a port picks up the feature under this name, that assertion goes
     * red, which is the signal the gap entry is stale.
     */
    name: string;
}

const isGap = (requirement: Export | Gap): requirement is Gap => "gap" in requirement;

type Requirement = Export | Gap;

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
        angular: {
            gap: "no JSX-like component model to build Authenticated/AuthLoading/Unauthenticated from — gate templates off the auth() signal directly",
            name: "Authenticated",
        },
        react: { name: "Authenticated" },
        solid: { name: "Authenticated" },
        svelte: {
            gap: "no JSX-like component model to build Authenticated/AuthLoading/Unauthenticated from — gate templates off the auth store directly",
            name: "Authenticated",
        },
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
        angular: { gap: "not yet ported — React-only today; see plan 231", name: "httpStream" },
        react: { name: "useHttpStream" },
        solid: { gap: "not yet ported — React-only today; see plan 231", name: "createHttpStream" },
        svelte: { gap: "not yet ported — React-only today; see plan 231", name: "httpStream" },
        vue: { gap: "not yet ported — React-only today; see plan 231", name: "useHttpStream" },
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
    // Chunked/multipart/TUS/paste file upload. Every adapter ships this as the
    // `./upload` subpath (`src/upload.ts`), never barreled into `index.ts` —
    // see the file header. Angular exports it as a bare `upload` (its
    // signal-style convention, like `voiceAgent`), the others as `useUpload` /
    // `createUpload`.
    upload: {
        angular: { module: "upload.ts", name: "upload", subpath: "./upload" },
        react: { module: "upload.ts", name: "useUpload", subpath: "./upload" },
        solid: { module: "upload.ts", name: "createUpload", subpath: "./upload" },
        svelte: { module: "upload.ts", name: "createUpload", subpath: "./upload" },
        vue: { module: "upload.ts", name: "useUpload", subpath: "./upload" },
    },
    voiceAgent: {
        angular: { name: "voiceAgent" },
        react: { name: "useVoiceAgent" },
        solid: { name: "createVoiceAgent" },
        svelte: { name: "voiceAgent" },
        vue: { name: "useVoiceAgent" },
    },
};

/** `filePath`'s exports, or `undefined` if the file doesn't exist. */
const tryNamedValueExportsOf = (filePath: string): Set<string> | undefined => {
    try {
        return namedValueExportsOf(filePath);
    } catch {
        return undefined;
    }
};

interface Verdict {
    message: string;
    ok: boolean;
}

/**
 * Resolve a single (feature, adapter) cell to a pass/fail verdict. Kept out of
 * the `it` body (and so out of `expect`) so the two branches — gap, real
 * check — never put a conditional around `expect` itself; the test below
 * makes exactly one unconditional assertion per cell.
 */
const verdictFor = (feature: string, byAdapter: Record<AdapterName, Requirement>, adapter: AdapterName): Verdict => {
    const requirement = byAdapter[adapter];

    if (isGap(requirement)) {
        // A `gap` entry must still say why — no silent absences.
        if (requirement.gap.length === 0) {
            return { message: `${feature}/${adapter} is on the gap list with an empty reason — every gap needs one`, ok: false };
        }

        // The symmetric guard: a gap is only honest while the export it names
        // is still absent. If a port has since shipped it, this must fail —
        // otherwise a filled gap stays green forever and the manifest quietly
        // lies about a feature that no longer has a gap (see plan 233 §5.2).
        const modulePath = join(ADAPTER_SRC[adapter], requirement.module ?? "index.ts");
        const exported = tryNamedValueExportsOf(modulePath);
        const filled = exported?.has(requirement.name) === true;

        return {
            message: filled
                ? `${feature}/${adapter} is on the gap list ("${requirement.gap}") but @lunora/${adapter} now exports "${requirement.name}" from ` +
                  `${requirement.module ?? "index.ts"} — the gap has been filled. Delete this REQUIRED_SURFACE gap entry and replace it with a real ` +
                  `{ name, module? } requirement.`
                : `${feature}/${adapter} gap: ${requirement.gap}`,
            ok: !filled,
        };
    }

    const modulePath = join(ADAPTER_SRC[adapter], requirement.module ?? "index.ts");
    const exported = tryNamedValueExportsOf(modulePath);

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

/** Every (feature, adapter) cell whose requirement is a subpath-backed `Export` (never a `Gap` — a gapped subpath has nothing to check yet). */
const subpathEntries = featureEntries.flatMap(([feature, byAdapter]) =>
    ADAPTER_NAMES.flatMap((adapter) => {
        const requirement = byAdapter[adapter];

        return !isGap(requirement) && requirement.subpath !== undefined ? [{ adapter, feature, subpath: requirement.subpath }] : [];
    }),
);

/** The adapter's `package.json` `exports` map, or `{}` if it declares none. */
const packageExportsOf = (adapter: AdapterName): Record<string, unknown> => {
    const packageJsonPath = join(PACKAGES_ROOT, adapter, "package.json");
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { exports?: Record<string, unknown> };

    return parsed.exports ?? {};
};

/** Every distinct module path (under an adapter's `src/`) any (feature, adapter) cell reads, gap or not. */
const allModulePaths = [
    ...new Set(featureEntries.flatMap(([, byAdapter]) => ADAPTER_NAMES.map((adapter) => join(ADAPTER_SRC[adapter], byAdapter[adapter].module ?? "index.ts")))),
];

describe("adapter export-surface parity (react, vue, solid, svelte, angular)", () => {
    // `ts-morph`'s first parse of a barrel that (transitively) pulls in JSX
    // source — react's `index.ts` re-exports `Authenticated`/`useLunora` from
    // `.tsx` files — pays for the checker's cold start, which comfortably
    // exceeds vitest's default 5s per-test timeout. Paying that cost once
    // here, for every module the suite will touch, means every individual
    // `it` below hits the (already-parsed, cached) `Project` and stays fast.
    // CI gets a much larger ceiling than local: under the full monorepo's
    // parallel `test:coverage` run — dozens of packages' vitest workers
    // contending for CPU at once, vs. this file running alone — the same cold
    // start has measured over 60s in CI (the prior fixed 30s, then 60s,
    // budgets both proved insufficient there), matching the CI-aware pattern
    // `packages/codegen/vitest.config.ts`'s `hookTimeout` already uses.
    beforeAll(
        () => {
            for (const modulePath of allModulePaths) {
                try {
                    namedValueExportsOf(modulePath);
                } catch {
                    // Doesn't exist yet (an angular `upload.ts`-shaped gap) — the
                    // per-cell checks below handle that; warming is best-effort.
                }
            }
        },
        process.env["CI"] ? 180_000 : 30_000,
    );

    it("declares a non-trivial manifest", () => {
        expect.assertions(1);

        expect(featureEntries.length).toBeGreaterThan(15);
    });

    describe.each(featureEntries)("%s", (feature, byAdapter) => {
        it.each(ADAPTER_NAMES)("%s carries it or has a documented gap", (adapter) => {
            expect.assertions(1);

            const verdict = verdictFor(feature, byAdapter, adapter);

            expect(verdict.ok, verdict.message).toBe(true);
        });
    });

    // The file-level check above only proves `src/upload.ts` exports the
    // right name — it never looks at `package.json`, so an adapter could drop
    // `"./upload"` from `exports` (breaking `import … from "@lunora/vue/upload"`)
    // while `src/upload.ts` itself stays untouched, and the check above would
    // stay green. Subpath-backed features need this second, independent
    // assertion against the actual package surface a consumer imports.
    describe("subpath-backed features carry their package.json export", () => {
        it.each(subpathEntries)("$feature: @lunora/$adapter's package.json exports carries $subpath", ({ adapter, feature, subpath }) => {
            expect.assertions(1);

            const exportsMap = packageExportsOf(adapter);

            expect(
                Object.hasOwn(exportsMap, subpath),
                `${feature}: @lunora/${adapter}'s package.json "exports" map does not carry "${subpath}". ` +
                    `${feature} is a subpath-backed feature — src/${subpath.replace("./", "")}.ts existing is not enough; ` +
                    `the exports map entry is what a consumer's "import … from '@lunora/${adapter}${subpath.slice(1)}'" actually resolves through.`,
            ).toBe(true);
        });
    });
});
