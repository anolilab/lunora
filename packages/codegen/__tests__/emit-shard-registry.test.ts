import { describe, expect, it } from "vitest";

import { emitShardRegistry } from "../src/emit/runtime-modules";

describe(emitShardRegistry, () => {
    it("re-exports ShardRegistryDO for a schema with .shardBy() tables", () => {
        expect.assertions(2);

        const tables = [{ shardMode: { field: "channelId", kind: "shardBy" } }] as const;

        expect(emitShardRegistry(tables, false)).toContain('export { ShardRegistryDO } from "@lunora/do";');
        expect(emitShardRegistry(tables, true)).toContain('export { ShardRegistryDO } from "lunorash/do";');
    });

    it("writes no module without .shardBy() tables, so nothing composes a registry", () => {
        expect.assertions(1);

        expect(emitShardRegistry([{ shardMode: "root" }, { shardMode: "global" }], false)).toBe("");
    });
});
