import { describe, expect, it } from "vitest";

import type { CapabilityKey } from "../src/capabilities";
import { emitApp } from "../src/emit-app";

/** Minimal `EmitAppOptions` with every capability off; tests flip one flag at a time. */
const baseOptions = {
    capabilities: new Set<CapabilityKey>(),
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

describe("emitApp — external-source client resolver", () => {
    // The shard config's source-client field and the ingest poll that reads it
    // both shipped, but nothing on the `defineApp()` builder could set the field —
    // and `createShardDO` is called from the generated `app.ts` and nowhere else in
    // a `defineApp()` project, which is every template. So a `.source()` table hit
    // the "no source client resolved for binding" branch on every tick forever.
    it("emits the builder method, the field and the config entry for a sourced schema", () => {
        expect.assertions(3);

        const output = emitApp({ ...baseOptions, hasSourcedTables: true });

        expect(output).toContain("private sourceClientFactory?:");
        expect(output).toContain("public sourceClient(factory: (env: Env, binding: string) =>");
        expect(output).toContain("...(this.sourceClientFactory === undefined ? {} : { sourceClient: this.sourceClientFactory }),");
    });

    // The method's parameter type reads `ShardConfig["sourceClient"]`, and that
    // config field is emitted on the same schema signal — so emitting the method
    // unconditionally would reference a type that is not there (the way the
    // shared `hasKv` flag once did for `.kv()`).
    it("emits nothing for a schema with no .source() table", () => {
        expect.assertions(1);

        expect(emitApp(baseOptions)).not.toContain("sourceClient");
    });
});
