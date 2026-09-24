import { describe, expect, it } from "vitest";

import { insertSchemaExtension } from "../../src/util/insert-schema-extension";

// The `if (!result.ok)` guards below narrow the `{ ok: true } | { ok: false }`
// discriminated union for type-safe `.text` access — they are not test-logic
// branching, so vitest/no-conditional-in-test is a false positive here.
/* eslint-disable vitest/no-conditional-in-test -- discriminated-union narrowing guards, not test branching */

const BASE_SCHEMA = `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    messages: defineTable({
        text: v.string(),
    }),
});
`;

// The shape every starter template ships: an anonymous `export default
// defineSchema(...)` (no `const schema = …` binding) imported from the `lunorash`
// umbrella. Regression for the scaffold failure
// `schema-extension merge failed for "ratelimit": no-define-schema`.
const DEFAULT_EXPORT_SCHEMA = `import { defineSchema, defineTable, v } from "lunorash/server";

export default defineSchema({
    messages: defineTable({
        channelId: v.string(),
        text: v.string(),
    })
        .shardBy("channelId")
        .index("by_channel", ["channelId"]),
});
`;

// What `templates/standalone` actually ships: the extension is already imported
// and chained, by hand, with no managed markers — because the template was
// authored with it rather than patched by `lunora add`.
const HAND_WIRED_SCHEMA = `import { ratelimit } from "./ratelimit/schema.js";
import { defineSchema, defineTable, v } from "lunorash/server";

export default defineSchema({
    messages: defineTable({
        channelId: v.string(),
        text: v.string(),
    })
        .shardBy("channelId")
        .index("by_channel", ["channelId"]),
}).extend(ratelimit.extension);
`;

describe("insertSchemaExtension", () => {
    it("refuses a key already bound by an unmarked import", () => {
        expect.assertions(1);

        // The idempotency gate read only the managed marker, which no template
        // carries — so `lunora add ratelimit` in a standalone project emitted a
        // SECOND `import { ratelimit }` and wrote a hard `SyntaxError: Identifier
        // 'ratelimit' has already been declared`, while reporting success.
        expect(insertSchemaExtension(HAND_WIRED_SCHEMA, "ratelimit")).toStrictEqual({ ok: false, reason: "already-applied" });
    });

    it("appends a .extend(<key>.extension) chain and a managed import", () => {
        expect.assertions(4);

        const result = insertSchemaExtension(BASE_SCHEMA, "ratelimit");

        expect(result.ok).toBe(true);

        if (!result.ok) {
            return;
        }

        expect(result.text).toContain('import { ratelimit } from "./ratelimit/schema";');
        expect(result.text).toContain(".extend(ratelimit.extension)");
        // user's existing table survives.
        expect(result.text).toContain("messages: defineTable");
    });

    it("is idempotent: a second merge for the same key is a no-op", () => {
        expect.assertions(2);

        const first = insertSchemaExtension(BASE_SCHEMA, "ratelimit");

        expect(first.ok).toBe(true);

        if (!first.ok) {
            return;
        }

        const second = insertSchemaExtension(first.text, "ratelimit");

        expect(second).toStrictEqual({ ok: false, reason: "already-applied" });
    });

    it("supports stacking multiple extensions", () => {
        expect.assertions(3);

        const first = insertSchemaExtension(BASE_SCHEMA, "ratelimit");

        if (!first.ok) {
            throw new Error("first merge failed");
        }

        const second = insertSchemaExtension(first.text, "mailer");

        expect(second.ok).toBe(true);

        if (!second.ok) {
            return;
        }

        expect(second.text).toContain(".extend(ratelimit.extension)");
        expect(second.text).toContain(".extend(mailer.extension)");
    });

    it("merges into an `export default defineSchema(...)` template (the umbrella default-export shape)", () => {
        expect.assertions(4);

        const result = insertSchemaExtension(DEFAULT_EXPORT_SCHEMA, "ratelimit");

        expect(result.ok).toBe(true);

        if (!result.ok) {
            return;
        }

        expect(result.text).toContain('import { ratelimit } from "./ratelimit/schema";');
        expect(result.text).toContain(".extend(ratelimit.extension)");
        // the `export default defineSchema(...)` head and the user's table survive.
        expect(result.text).toContain("export default defineSchema(");
    });

    it("stacks multiple extensions onto an `export default defineSchema(...)` template", () => {
        expect.assertions(3);

        const first = insertSchemaExtension(DEFAULT_EXPORT_SCHEMA, "ratelimit");

        if (!first.ok) {
            throw new Error("first merge failed");
        }

        const second = insertSchemaExtension(first.text, "presence");

        expect(second.ok).toBe(true);

        if (!second.ok) {
            return;
        }

        expect(second.text).toContain(".extend(ratelimit.extension)");
        expect(second.text).toContain(".extend(presence.extension)");
    });

    it("reports no-define-schema when there is no defineSchema call", () => {
        expect.assertions(1);

        const result = insertSchemaExtension("export const schema = {};\n", "ratelimit");

        expect(result).toStrictEqual({ ok: false, reason: "no-define-schema" });
    });

    it.each(["2fa", "rate-limit", "with space"])("rejects %s as an invalid JS identifier (would emit uncompilable schema.ts)", (key) => {
        expect.assertions(1);

        const result = insertSchemaExtension(BASE_SCHEMA, key);

        expect(result).toStrictEqual({ ok: false, reason: "invalid-identifier" });
    });
});
