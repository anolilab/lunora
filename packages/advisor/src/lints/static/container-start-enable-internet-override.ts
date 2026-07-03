import emit from "../../finding";
import type { Lint } from "../../types";

const containerStartEnableInternetOverride: Lint = {
    categories: ["SECURITY"],
    description:
        "A runtime `.start({ enableInternet: true, … })` call overrides the static `defineContainer` declaration and re-opens public internet " +
        "egress for that container instance, defeating the `container_public_internet` lint's assumption that the declaration is authoritative.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "container_start_enable_internet_override",
    remediation:
        "Avoid overriding `enableInternet` at `.start()` time. Set it once on the `defineContainer` declaration in `lunora/containers.ts` so the " +
        "static advisors can reason about it, and gate any runtime opt-in behind a server-trusted check rather than an unconditional literal.",
    run: (context) => {
        if (context.containerOverrides === undefined) {
            return [];
        }

        return context.containerOverrides
            .filter((override) => override.kind === "enable_internet")
            .map((override) =>
                emit(containerStartEnableInternetOverride, {
                    cacheKey: `container_start_enable_internet_override:${override.file}:${override.line.toString()}`,
                    detail: `\`${override.exportName}\` calls \`.start({ enableInternet: true })\`, overriding the container's static egress posture.`,
                    metadata: { exportName: override.exportName, file: override.file, line: override.line },
                }),
            );
    },
    source: "static",
    title: "Runtime .start() override re-enables container internet access",
};

export default containerStartEnableInternetOverride;
