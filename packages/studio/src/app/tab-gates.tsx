import type { ReactElement } from "react";

import { EmptyState } from "../components/ui/empty-state";
import type { MessageId, TFunction } from "../i18n/i18n-context";
import type { StudioFeatures, StudioFeaturesResult } from "../lib/admin";
import type { NavGroup, StudioTab } from "./nav-types";

/**
 * The `@lunora/platform` capability keys (`PlatformCapabilities["features"]`) a
 * studio page can be gated on. A studio-side union because the studio does not
 * depend on `@lunora/platform` at runtime; a test pins every member against
 * both shipped matrices, so a typo or a renamed key fails there.
 */
type CapabilityKey =
    | "agents"
    | "analytics"
    | "containers"
    | "crossShardFanout"
    | "keyValueStore"
    | "mail"
    | "objectStorage"
    | "pointInTimeRecovery"
    | "queues"
    | "scheduler"
    | "serverReactors"
    | "vectorStore"
    | "workflows";

/** A usage flag from the worker's `studioFeatures` payload. */
type FeatureFlag = Exclude<keyof StudioFeaturesResult, "platform">;

/**
 * What a tab needs before its panel is useful. The two gates answer different
 * questions and fail differently.
 *
 * `feature` asks whether the APP wires the backing package: a usage flag codegen
 * discovers statically (`__lunora_admin__:studioFeatures`). Off ⇒ the page is
 * hidden outright and its URL bounces to Home, so an app with no
 * `@lunora/payment` never shows Payments. `auth` gates all five auth pages,
 * including the audit trail, whose RPC answers `AUTH_AUDIT_NOT_CONFIGURED`
 * without `@lunora/auth`'s reader.
 *
 * `capability` asks whether the worker's HOST can serve it: the worker reports
 * which capabilities its target rates `unsupported`. Such a page stays in the
 * nav, dimmed with the reason, leaves the ⌘K palette, and its route renders the
 * reason instead of a panel whose admin ops cannot answer there.
 *
 * Tabs absent from this table are core surfaces and always shown.
 * `storageRules` has no capability: it renders codegen metadata and asks the
 * host for nothing.
 */
interface TabGate {
    readonly capability?: CapabilityKey;
    readonly feature?: FeatureFlag;
}

const TAB_GATES: Partial<Record<StudioTab, TabGate>> = {
    agents: { capability: "agents" },
    analytics: { capability: "analytics", feature: "analytics" },
    authAudit: { feature: "auth" },
    authConfig: { feature: "auth" },
    authSessions: { feature: "auth" },
    containers: { capability: "containers", feature: "containers" },
    fanout: { capability: "crossShardFanout" },
    files: { capability: "objectStorage", feature: "storage" },
    flags: { feature: "flags" },
    kv: { capability: "keyValueStore", feature: "kv" },
    mail: { capability: "mail", feature: "mail" },
    notifications: { feature: "notifications" },
    organizations: { feature: "auth" },
    payments: { feature: "payments" },
    pitr: { capability: "pointInTimeRecovery" },
    queues: { capability: "queues", feature: "queues" },
    reactors: { capability: "serverReactors" },
    schedule: { capability: "scheduler", feature: "scheduler" },
    storageRules: { feature: "storage" },
    users: { feature: "auth" },
    vectors: { capability: "vectorStore", feature: "vectors" },
    workflows: { capability: "workflows", feature: "workflows" },
};

/** How each capability reads in an operator-facing reason. */
const CAPABILITY_LABEL: Record<CapabilityKey, MessageId> = {
    agents: "Durable agents",
    analytics: "Analytics",
    containers: "Containers",
    crossShardFanout: "Cross-shard fan-out",
    keyValueStore: "Key-value storage",
    mail: "Mail delivery",
    objectStorage: "Object storage",
    pointInTimeRecovery: "Point-in-time recovery",
    queues: "Queues",
    scheduler: "Scheduling",
    serverReactors: "Server reactors",
    vectorStore: "Vector search",
    workflows: "Workflows",
};

/**
 * `hidden`: the app does not wire the page. `pending`: the page needs a host
 * capability and the worker has not answered yet, so nothing may mount.
 * `unavailable`: the host cannot serve it, and why. `ok`: render the panel.
 */
type TabVerdict = { readonly kind: "hidden" | "ok" | "pending" } | { readonly kind: "unavailable"; readonly reason: string };

const HIDDEN: TabVerdict = { kind: "hidden" };
const OK: TabVerdict = { kind: "ok" };
const PENDING: TabVerdict = { kind: "pending" };

const gateTab = (tab: StudioTab, features: StudioFeatures, t: TFunction): TabVerdict => {
    const gate = TAB_GATES[tab];

    if (gate?.feature !== undefined && !features[gate.feature]) {
        return HIDDEN;
    }

    if (gate?.capability === undefined) {
        return OK;
    }

    // Fail closed until the worker answers: the default flags say nothing about
    // the host, and mounting a panel first would fire the very RPC the gate
    // exists to withhold.
    if (!features.settled) {
        return PENDING;
    }

    return features.platform?.unsupported.includes(gate.capability) === true
        ? {
              kind: "unavailable",
              reason: t("{capability} is not supported on {platform}.", { capability: t(CAPABILITY_LABEL[gate.capability]), platform: features.platform.name }),
          }
        : OK;
};

/**
 * Apply {@link gateTab} to the whole nav: drop hidden tabs (and any group left
 * empty), and collect the reason for every tab the host cannot serve.
 */
const resolveNav = (
    groups: ReadonlyArray<NavGroup>,
    features: StudioFeatures,
    t: TFunction,
): { readonly unavailable: Partial<Record<StudioTab, string>>; readonly visibleGroups: NavGroup[] } => {
    const unavailable: Partial<Record<StudioTab, string>> = {};
    const visibleGroups: NavGroup[] = [];

    for (const group of groups) {
        const tabs: StudioTab[] = [];

        for (const tab of group.tabs) {
            const verdict = gateTab(tab, features, t);

            if (verdict.kind !== "hidden") {
                tabs.push(tab);
            }

            if (verdict.kind === "unavailable") {
                unavailable[tab] = verdict.reason;
            }
        }

        if (tabs.length > 0) {
            visibleGroups.push({ ...group, tabs });
        }
    }

    return { unavailable, visibleGroups };
};

/** What a direct link to an unavailable page renders in place of its panel, so it explains rather than errors. */
const UnsupportedPanel = ({ reason, title }: { readonly reason: string; readonly title: string }): ReactElement => (
    <EmptyState description={reason} testId="dash-unsupported" title={title} />
);

export type { CapabilityKey, TabVerdict };
export { gateTab, resolveNav, TAB_GATES, UnsupportedPanel };
