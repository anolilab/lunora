/**
 * One container declaration discovered in `cirrus/containers.ts` — the input
 * the `container_*` lints consume. Produced by the codegen feeder (which lifts
 * the static fields of each `defineContainer({...})` export); runtime callers
 * don't supply it, so the container lints simply find nothing there.
 *
 * A structural subset of codegen's `ContainerIR`, so the feeder can pass the
 * IR array straight through without conversion (mirrors how `AdvisorQueryRead`
 * tracks `QueryReadIR`).
 */
export interface AdvisorContainer {
    /**
     * Whether outbound internet was explicitly configured. `undefined` means
     * the field was omitted (platform default `true`) or wasn't a static literal.
     */
    enableInternet?: boolean;
    /** The `cirrus/containers.ts` export name, e.g. `transcoder`. */
    exportName: string;
    /** Declared `instanceType`: a named size, or a custom `{ vcpu, memoryMib, diskMb }`. */
    instanceType?: string | { diskMb?: number; memoryMib?: number; vcpu?: number };
    /** Declared `maxInstances` cap, when present. */
    maxInstances?: number;
    /** Declared `sleepAfter` value, when a static literal. */
    sleepAfter?: number | string;
}
