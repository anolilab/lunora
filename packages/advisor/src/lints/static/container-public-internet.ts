import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a container that leaves outbound internet access at the platform
 * default (`enableInternet: true`). Egress is billed per GB and an open
 * outbound path widens the attack surface, so a container that doesn't call
 * external services should set `enableInternet: false` explicitly. We can't
 * tell from config whether egress is actually used, so this is an INFO nudge to
 * make the choice deliberate, not an error.
 *
 * Only fires when the field was omitted (or a non-literal we couldn't read) —
 * an explicit `enableInternet: true` is treated as a deliberate opt-in and left
 * alone.
 */
const containerPublicInternet: Lint = {
    categories: ["SECURITY"],
    description: "A container leaves outbound internet access at the default (enabled), which is billed per GB of egress and widens the attack surface.",
    facing: "INTERNAL",
    level: "INFO",
    name: "container_public_internet",
    remediation: "Set `enableInternet: false` on the container if it doesn't call external services, or `true` to opt in deliberately.",
    run: (context) =>
        (context.containers ?? [])
            .filter((container) => container.enableInternet === undefined)
            .map((container) =>
                emit(containerPublicInternet, {
                    cacheKey: `container_public_internet:${container.exportName}`,
                    detail: `Container "${container.exportName}" doesn't set enableInternet, so outbound internet is on by default (egress is billed).`,
                    metadata: { container: container.exportName },
                }),
            ),
    source: "static",
    title: "Container egress enabled by default",
};

export default containerPublicInternet;
