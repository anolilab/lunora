import { callSiteDescription } from "../../call-site-scope";
import emit from "../../finding";
import type { Lint } from "../../types";
import { callSiteFields } from "../helpers";

const containerRuntimeEgressRelaxation: Lint = {
    categories: ["SECURITY"],
    description:
        "A runtime `.egress.allow(...)` / `.egress.deny(...)` / `.egress.setAllowed(...)` call mutates the container's egress firewall at " +
        "runtime, re-opening a network surface the static analysis assumes is locked to the `defineContainer` declaration.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "container_runtime_egress_relaxation",
    remediation:
        "Prefer declaring the egress policy statically in `lunora/containers.ts` where it is auditable. When a runtime mutation is unavoidable, " +
        "scope it behind a server-trusted check and keep the change narrow (a specific host, not a broad allow) rather than an unconditional relaxation.",
    run: (context) => {
        if (context.containerOverrides === undefined) {
            return [];
        }

        return context.containerOverrides
            .filter((override) => override.kind === "egress_relaxation")
            .map((override) =>
                emit(containerRuntimeEgressRelaxation, {
                    cacheKey: `container_runtime_egress_relaxation:${override.file}:${override.line.toString()}`,
                    detail: `${callSiteDescription(override.scope)} calls \`.egress.${override.detail}(...)\` at runtime, mutating the container's egress firewall.`,
                    metadata: { ...callSiteFields(override), method: override.detail },
                }),
            );
    },
    source: "static",
    title: "Runtime egress mutation relaxes the container firewall",
};

export default containerRuntimeEgressRelaxation;
