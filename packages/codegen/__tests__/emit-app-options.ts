import type { EmitAppOptions } from "../src/emit-app";

/** Minimal `EmitAppOptions` with every capability off; each `emit-app-*` test flips only the flags it exercises. */
const baseOptions: EmitAppOptions = {
    capabilities: new Set(),
    hasAccess: false,
    hasAuth: false,
    hasFramework: false,
    hasGlobal: false,
    hasHyperdriveGlobal: false,
    hasKvIntrospector: false,
    hasNotify: false,
    hasQueue: false,
    hasScheduler: false,
    hasSourcedTables: false,
    hasStorage: false,
    hasVectors: false,
    hasWorkflow: false,
    tables: [],
    useUmbrella: false,
    wantsArchitecture: false,
    wantsOpenApi: false,
    wantsOpenRpc: false,
};

export default baseOptions;
