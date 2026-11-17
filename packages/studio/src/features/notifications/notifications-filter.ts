import type { PushSubscriptionDevice } from "../../lib/admin";

/** The kind filter the toolbar toggles between (`"all"` clears it). */
export type KindFilter = "all" | "fcm" | "web-push";

/** How a device is shown and matched: its endpoint, or its id when it has none. */
export const deviceTarget = (device: PushSubscriptionDevice): string => device.endpoint ?? device.id;

/**
 * One pass over the rows: the kind and search scope, the failing devices within it, and the list the
 * panel shows (the failing-only view when enabled). Kept out of the component so the component stays simple.
 */
export const partitionDevices = (
    devices: PushSubscriptionDevice[],
    kind: KindFilter,
    search: string,
    failingOnly: boolean,
): { failing: PushSubscriptionDevice[]; filtered: PushSubscriptionDevice[] } => {
    const needle = search.trim().toLowerCase();
    const scoped: PushSubscriptionDevice[] = [];
    const failing: PushSubscriptionDevice[] = [];

    for (const device of devices) {
        const kindMatches = kind === "all" || device.kind === kind;
        const searchMatches = needle === "" || `${deviceTarget(device)} ${device.userId ?? ""}`.toLowerCase().includes(needle);

        if (kindMatches && searchMatches) {
            scoped.push(device);

            if (device.lastStatus === "failed") {
                failing.push(device);
            }
        }
    }

    return { failing, filtered: failingOnly ? failing : scoped };
};
