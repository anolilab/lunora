import { describe, expect, it } from "vitest";

import { emitShardRegistry } from "../src/emit/runtime-modules";

describe(emitShardRegistry, () => {
    it("re-exports ShardRegistryDO for a schema with .shardBy() tables", () => {
        expect.assertions(2);

        expect(emitShardRegistry(true, false)).toContain('export { ShardRegistryDO } from "@lunora/do";');
        expect(emitShardRegistry(true, true)).toContain('export { ShardRegistryDO } from "lunorash/do";');
    });

    it("writes no module without .shardBy() tables, so nothing composes a registry", () => {
        expect.assertions(1);

        expect(emitShardRegistry(false, false)).toBe("");
    });
});
