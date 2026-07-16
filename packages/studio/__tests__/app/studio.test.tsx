import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Studio } from "../../src/app/studio";
import type {
    FanoutMetricsResult,
    FanoutPathCounters,
    FanoutTopicStat,
    FlagEvaluation,
    FlagsResult,
    QueueMessageRow,
    QueueMetadata,
    StudioFeaturesResult,
} from "../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../src/lib/admin";
import type { MockClientHooks } from "../mock-client";
import { createMockClient } from "../mock-client";

const createClient = (features?: Partial<StudioFeaturesResult>): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.listTables) {
                return [{ name: "messages", rowCount: 1 }];
            }

            if (reference === ADMIN_FUNCTIONS.migrationStatus) {
                return { migrations: [] };
            }

            if (reference === ADMIN_FUNCTIONS.getSecurityAudit) {
                return { findings: [] };
            }

            if (reference === ADMIN_FUNCTIONS.getFunctionStats) {
                return { functions: [], sinceMs: 0 };
            }

            // Optional-feature flags drive which nav pages render. Default every
            // flag on (the studio's back-compat default) unless a test overrides one.
            if (reference === ADMIN_FUNCTIONS.studioFeatures) {
                return {
                    analytics: true,
                    auth: true,
                    containers: true,
                    flags: true,
                    kv: true,
                    mail: true,
                    payments: true,
                    queues: true,
                    scheduler: true,
                    storage: true,
                    vectors: true,
                    workflows: true,
                    ...features,
                };
            }

            // The logs panel mounts when its domain is opened; hand it the real
            // result shape (an `entries` array) rather than the table fallback so
            // it seeds an empty buffer instead of `undefined`.
            if (reference === ADMIN_FUNCTIONS.getLogs || reference === ADMIN_FUNCTIONS.getRequestLog) {
                return { entries: [] };
            }

            return { columns: [], rows: [], total: 0 };
        },
    });

const renderStudio = (mock: MockClientHooks) => (
    <LunoraProvider client={mock.asClient}>
        <Studio />
    </LunoraProvider>
);

/** Render the default studio and resolve the given sidebar page button once the router settles. */
const renderAndFind = async (testId: string): Promise<HTMLElement> => {
    render(renderStudio(createClient()));

    return screen.findByTestId(testId);
};

/**
 * Canonical key set of `StudioFeaturesResult`. This hand-mirror lives in
 * `@lunora/studio` because it can't import `@lunora/do`; the same tuple and guard
 * live in `@lunora/do`'s `shard-do.admin.test.ts`. `lint:types` fails here if the
 * studio copy of the type drifts from this tuple — keeping both packages' copies
 * of the wire contract in lockstep.
 */
const STUDIO_FEATURE_KEYS = [
    "analytics",
    "auth",
    "containers",
    "flags",
    "kv",
    "mail",
    "payments",
    "queues",
    "scheduler",
    "storage",
    "vectors",
    "workflows",
] as const;

/** `true` only when `Keys` and `Canonical` are mutually assignable (the exact same key set). */
type KeysMatch<Keys extends string, Canonical extends string> = [Keys] extends [Canonical] ? ([Canonical] extends [Keys] ? true : never) : never;

// Compile-time drift guard: assigning `true` fails tsc the moment the key sets diverge.
const STUDIO_FEATURES_KEY_GUARD: KeysMatch<keyof StudioFeaturesResult, (typeof STUDIO_FEATURE_KEYS)[number]> = true;

/**
 * Canonical key set of `QueueMetadata` — hand-mirrored from `@lunora/do` the same
 * way as `StudioFeaturesResult`. The studio `QueuesPanel` reads these fields off
 * the wire, so a field added on one side and not the other would surface as a
 * silent `undefined` cell rather than a type error; this guard fails the build on
 * drift instead. `deadLetterQueue` is optional (push-only), so it's in the set.
 */
const QUEUE_METADATA_KEYS = ["binding", "deadLetterQueue", "exportName", "mode", "name"] as const;

const QUEUE_METADATA_KEY_GUARD: KeysMatch<keyof QueueMetadata, (typeof QUEUE_METADATA_KEYS)[number]> = true;

/**
 * Canonical key set of `QueueMessageRow` (the `getQueueMessages` consumed-message
 * log row) — hand-mirrored from `@lunora/do` the same way as `QueueMetadata`. The
 * `QueuesPanel` Messages tab reads these fields off the wire, so a drift would
 * surface as a silent `undefined` cell; this guard fails the build instead.
 * `error`/`exportName` are optional.
 */
const QUEUE_MESSAGE_ROW_KEYS = [
    "attempts",
    "body",
    "capturedAt",
    "deadLettered",
    "error",
    "exportName",
    "id",
    "messageId",
    "outcome",
    "queue",
    "timestamp",
] as const;

const QUEUE_MESSAGE_ROW_KEY_GUARD: KeysMatch<keyof QueueMessageRow, (typeof QUEUE_MESSAGE_ROW_KEYS)[number]> = true;

/**
 * Canonical key sets of `FlagEvaluation` / `FlagsResult` — hand-mirrored from
 * `@lunora/do` the same way as the types above, with the matching guards living
 * in `@lunora/do`'s `shard-do.admin.test.ts`. The studio Flags page reads these
 * fields off the wire, so a field dropped from the mirror (e.g. `variant`) would
 * surface as a silent `undefined` cell rather than a type error; these guards
 * fail the build on drift. `errorCode`/`reason`/`variant` are optional (present
 * only when the provider reports them), so they're in the set.
 */
const FLAG_EVALUATION_KEYS = ["errorCode", "key", "reason", "type", "value", "variant"] as const;

const FLAG_EVALUATION_KEY_GUARD: KeysMatch<keyof FlagEvaluation, (typeof FLAG_EVALUATION_KEYS)[number]> = true;

const FLAGS_RESULT_KEYS = ["configured", "flags"] as const;

const FLAGS_RESULT_KEY_GUARD: KeysMatch<keyof FlagsResult, (typeof FLAGS_RESULT_KEYS)[number]> = true;

/**
 * Canonical key sets of the `getFanoutMetrics` wire shapes (plan 075 Phase 1) —
 * hand-mirrored from `@lunora/do` the same way as the types above, with the
 * matching guards living in `@lunora/do`'s `shard-do.admin.test.ts`. The fan-out
 * panel reads these fields off the wire, so a dropped field would surface as a
 * silent `undefined` cell rather than a type error; these guards fail the build
 * on drift.
 */
const FANOUT_TOPIC_STAT_KEYS = ["kind", "subscribers", "topic"] as const;

const FANOUT_TOPIC_STAT_KEY_GUARD: KeysMatch<keyof FanoutTopicStat, (typeof FANOUT_TOPIC_STAT_KEYS)[number]> = true;

const FANOUT_PATH_COUNTERS_KEYS = ["maxMs", "passes", "peakSocketsIterated", "socketsDelivered", "socketsIterated", "totalMs"] as const;

const FANOUT_PATH_COUNTERS_KEY_GUARD: KeysMatch<keyof FanoutPathCounters, (typeof FANOUT_PATH_COUNTERS_KEYS)[number]> = true;

const FANOUT_METRICS_RESULT_KEYS = [
    "maxRelays",
    "peakSubscribers",
    "promoted",
    "relayCount",
    "shapePoke",
    "sinceMs",
    "topics",
    "totalConnections",
    "whisper",
] as const;

const FANOUT_METRICS_RESULT_KEY_GUARD: KeysMatch<keyof FanoutMetricsResult, (typeof FANOUT_METRICS_RESULT_KEYS)[number]> = true;

describe("studio", () => {
    it("renders every domain's sub-pages at once in the grouped sidebar", async () => {
        expect.assertions(4);

        render(renderStudio(createClient()));

        // The single grouped sidebar renders inside the router's root route
        // (resolved a tick after mount) and lists every visible page directly —
        // no rail to open first — so the home, database, and logs pages all show.
        await expect(screen.findByTestId("dash-tab-home")).resolves.toBeDefined();
        expect(screen.getByTestId("dash-tab-data")).toBeDefined();
        expect(screen.getByTestId("dash-tab-schedule")).toBeDefined();
        expect(screen.getByTestId("dash-tab-settings")).toBeDefined();
    });

    it("renders the schedule panel via the client when its sub-page is selected", async () => {
        expect.assertions(1);

        fireEvent.click(await renderAndFind("dash-tab-schedule"));

        const scheduledJobs = await screen.findByTestId("lunora-scheduled-jobs");

        expect(scheduledJobs).toBeDefined();
    });

    it("renders the Security Advisor when the Security sub-page is selected", async () => {
        expect.assertions(1);

        fireEvent.click(await renderAndFind("dash-tab-security"));

        await expect(screen.findByTestId("lunora-security-advisor")).resolves.toBeDefined();
    });

    it("switches the active panel when a sub-page is clicked", async () => {
        expect.assertions(1);

        fireEvent.click(await renderAndFind("dash-tab-migrations"));

        await screen.findByTestId("lunora-migrations");

        expect(screen.queryByTestId("lunora-home")).toBeNull();
    });

    it("collapses the sidebar to icons from the rail trigger", async () => {
        expect.assertions(2);

        const { container } = render(renderStudio(createClient()));

        await screen.findByTestId("dash-tab-home");
        const trigger = screen.getByRole("button", { name: /toggle sidebar/i });

        // The desktop sidebar carries its expanded/collapsed state on the container.
        // eslint-disable-next-line testing-library/no-node-access, testing-library/no-container -- the state lives as a data attribute on the sidebar shell, not on a queryable role.
        const sidebar = container.querySelector<HTMLElement>('[data-slot="sidebar"][data-state]');

        expect(sidebar?.dataset.state).toBe("expanded");

        fireEvent.click(trigger);

        expect(sidebar?.dataset.state).toBe("collapsed");
    });

    it("hides a domain's pages when its optional package is disabled", async () => {
        expect.assertions(2);

        render(renderStudio(createClient({ storage: false })));

        // Home is package-independent, so its page is always present — await it
        // first so the async feature fetch has resolved before we assert absence.
        await screen.findByTestId("dash-tab-home");

        await waitFor(() => {
            expect(screen.queryByTestId("dash-tab-files")).toBeNull();
        });

        // A domain whose feature stays enabled is untouched.
        expect(screen.getByTestId("dash-tab-data")).toBeDefined();
    });

    it("hides a single sub-page when its feature is disabled but keeps the domain's other pages", async () => {
        expect.assertions(2);

        // payments lives in the "logs" domain alongside logs/audit/schedule — disabling
        // it should drop only the payments sub-page, not the whole domain.
        render(renderStudio(createClient({ payments: false })));

        await screen.findByTestId("dash-tab-logs");

        await waitFor(() => {
            expect(screen.queryByTestId("dash-tab-payments")).toBeNull();
        });

        expect(screen.getByTestId("dash-tab-logs")).toBeDefined();
    });

    it("labels the panel region by the active sub-page", async () => {
        expect.assertions(1);

        fireEvent.click(await renderAndFind("dash-tab-logs"));

        await waitFor(() => {
            expect(screen.getByTestId("dash-panel").getAttribute("aria-labelledby")).toBe("dash-tab-logs");
        });
    });

    it("keeps the studio's StudioFeaturesResult mirror in lockstep with @lunora/do's contract", () => {
        expect.assertions(2);

        // The compile-time guard (STUDIO_FEATURES_KEY_GUARD) fails the build on drift;
        // this asserts the canonical tuple at runtime so the guard can't be silently deleted.
        expect(STUDIO_FEATURES_KEY_GUARD).toBe(true);
        expect([...STUDIO_FEATURE_KEYS]).toStrictEqual([
            "analytics",
            "auth",
            "containers",
            "flags",
            "kv",
            "mail",
            "payments",
            "queues",
            "scheduler",
            "storage",
            "vectors",
            "workflows",
        ]);
    });

    it("keeps the studio's QueueMetadata mirror in lockstep with @lunora/do's contract", () => {
        expect.assertions(2);

        expect(QUEUE_METADATA_KEY_GUARD).toBe(true);
        expect([...QUEUE_METADATA_KEYS]).toStrictEqual(["binding", "deadLetterQueue", "exportName", "mode", "name"]);
    });

    it("keeps the studio's QueueMessageRow mirror in lockstep with @lunora/do's contract", () => {
        expect.assertions(2);

        expect(QUEUE_MESSAGE_ROW_KEY_GUARD).toBe(true);
        expect([...QUEUE_MESSAGE_ROW_KEYS]).toStrictEqual([
            "attempts",
            "body",
            "capturedAt",
            "deadLettered",
            "error",
            "exportName",
            "id",
            "messageId",
            "outcome",
            "queue",
            "timestamp",
        ]);
    });

    it("keeps the studio's FlagEvaluation/FlagsResult mirror in lockstep with @lunora/do's contract", () => {
        expect.assertions(4);

        expect(FLAG_EVALUATION_KEY_GUARD).toBe(true);
        expect([...FLAG_EVALUATION_KEYS]).toStrictEqual(["errorCode", "key", "reason", "type", "value", "variant"]);
        expect(FLAGS_RESULT_KEY_GUARD).toBe(true);
        expect([...FLAGS_RESULT_KEYS]).toStrictEqual(["configured", "flags"]);
    });

    it("keeps the studio's getFanoutMetrics mirror in lockstep with @lunora/do's contract", () => {
        expect.assertions(6);

        expect(FANOUT_TOPIC_STAT_KEY_GUARD).toBe(true);
        expect([...FANOUT_TOPIC_STAT_KEYS]).toStrictEqual(["kind", "subscribers", "topic"]);
        expect(FANOUT_PATH_COUNTERS_KEY_GUARD).toBe(true);
        expect([...FANOUT_PATH_COUNTERS_KEYS]).toStrictEqual(["maxMs", "passes", "peakSocketsIterated", "socketsDelivered", "socketsIterated", "totalMs"]);
        expect(FANOUT_METRICS_RESULT_KEY_GUARD).toBe(true);
        expect([...FANOUT_METRICS_RESULT_KEYS]).toStrictEqual([
            "maxRelays",
            "peakSubscribers",
            "promoted",
            "relayCount",
            "shapePoke",
            "sinceMs",
            "topics",
            "totalConnections",
            "whisper",
        ]);
    });
});
