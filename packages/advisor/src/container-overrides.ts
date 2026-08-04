/**
 * One runtime container-override call: a `<handle>.start({ enableInternet: true, … })`
 * launch override, or a `<handle>.egress.<method>(...)` runtime firewall mutation
 * (`allow` / `deny` / `setAllowed`) — the `container_start_enable_internet_override`
 * and `container_runtime_egress_relaxation` lint input. Both shapes re-open network
 * access the static `defineContainer` declaration (and its `container_public_internet`
 * lint) assumes is locked down. Structurally identical to `ContainerOverrideIR`.
 */
export interface AdvisorContainerOverride {
    /** e.g. the egress method name, or `"enableInternet: true"`. */
    detail: string;
    /** Export binding name of the procedure performing the call. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** Which override shape matched. */
    kind: "egress_relaxation" | "enable_internet";
    /** 1-based line of the call, or `0` when unknown. */
    line: number;
}
