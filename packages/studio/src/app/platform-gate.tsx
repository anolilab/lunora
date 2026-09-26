import type { ReactElement } from "react";

import { EmptyState } from "../components/ui/empty-state";
import type { TFunction } from "../i18n/i18n-context";
import type { StudioPlatform } from "../lib/admin";
import type { StudioTab } from "./nav-types";

/**
 * The `@lunora/platform` capability each host-backed page needs, keyed like
 * `PlatformCapabilities["features"]`. A tab absent here runs on anything the
 * shard itself serves (data, schema, logs, traces, evals, …) and is never
 * capability-gated. This is a second gate beside the usage flags, not a
 * replacement: the flags say whether the APP wires a feature, this says whether
 * the HOST can serve it.
 */
const TAB_CAPABILITY: Partial<Record<StudioTab, string>> = {
    agents: "agents",
    analytics: "analytics",
    containers: "containers",
    fanout: "crossShardFanout",
    files: "objectStorage",
    kv: "keyValueStore",
    mail: "mail",
    pitr: "pointInTimeRecovery",
    queues: "queues",
    reactors: "serverReactors",
    schedule: "scheduler",
    storageRules: "objectStorage",
    vectors: "vectorStore",
    workflows: "workflows",
};

/**
 * Why `tab` is unavailable on the worker's host, or `undefined` when it is
 * available. Only an explicit `unsupported` rating gates: `emulated` is a
 * working surface, and a missing rating or a missing `platform` (a worker that
 * predates the report) fails open, like the usage flags do.
 */
const unsupportedReason = (tab: StudioTab, platform: StudioPlatform | undefined, t: TFunction): string | undefined => {
    const feature = TAB_CAPABILITY[tab];

    if (feature === undefined || platform?.features[feature] !== "unsupported") {
        return undefined;
    }

    return t("Not available on {platform}: its capability matrix rates {feature} unsupported.", { feature, platform: platform.name });
};

/** What a direct link to an unavailable page renders in place of its panel, so it explains rather than errors. */
const UnsupportedPanel = ({ reason, title }: { readonly reason: string; readonly title: string }): ReactElement => (
    <EmptyState description={reason} testId="dash-unsupported" title={title} />
);

export { UnsupportedPanel, unsupportedReason };
