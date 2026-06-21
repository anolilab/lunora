import emit from "../../finding";
import type { Lint } from "../../types";

/** Named instance sizes we consider "large" — a deliberate, cost-significant choice. */
const LARGE_NAMED = new Set(["standard-3", "standard-4"]);

/** Custom-instance thresholds above which we nudge: > 2 vCPU or > 4 GiB memory. */
const VCPU_THRESHOLD = 2;
const MEMORY_MIB_THRESHOLD = 4096;

/** Whether a declared `instanceType` counts as "large" by our heuristic. */
const isOversized = (instanceType: NonNullable<AdvisorContainerInstanceType>): boolean =>
    typeof instanceType === "string"
        ? LARGE_NAMED.has(instanceType)
        : (instanceType.vcpu ?? 0) > VCPU_THRESHOLD || (instanceType.memoryMib ?? 0) > MEMORY_MIB_THRESHOLD;

type AdvisorContainerInstanceType = string | { diskMb?: number; memoryMib?: number; vcpu?: number };

/**
 * Flags a container declared on a large instance type. The big `standard-3` /
 * `standard-4` sizes (and large custom shapes) are billed on their provisioned
 * memory + disk for the whole time an instance runs, so an over-provisioned
 * container is a standing cost. Informational — a real workload may need it —
 * but worth surfacing so the choice is deliberate.
 */
const containerOversizedInstance: Lint = {
    categories: ["PERFORMANCE"],
    description: "A container is declared on a large instance type, whose provisioned memory and disk are billed for the lifetime of every running instance.",
    facing: "INTERNAL",
    level: "INFO",
    name: "container_oversized_instance",
    remediation: "Confirm the workload needs this size; a smaller instanceType (lite/basic/standard-1) costs less while idle-but-running.",
    run: (context) => {
        const findings = [];

        for (const container of context.containers ?? []) {
            const { instanceType } = container;

            if (instanceType === undefined || !isOversized(instanceType)) {
                continue;
            }

            const size = typeof instanceType === "string" ? instanceType : JSON.stringify(instanceType);

            findings.push(
                emit(containerOversizedInstance, {
                    cacheKey: `container_oversized_instance:${container.exportName}`,
                    detail: `Container "${container.exportName}" uses a large instance type (${size}); its memory + disk are billed while any instance runs.`,
                    metadata: { container: container.exportName, instanceType },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Oversized container instance",
};

export default containerOversizedInstance;
