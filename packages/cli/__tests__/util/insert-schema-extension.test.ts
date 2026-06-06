import { describe, expect, it } from "vitest";

import { insertSchemaExtension } from "../../src/util/insert-schema-extension.js";

const BASE_SCHEMA = `import { defineSchema, defineTable, v } from "@cirrus/server";

export const schema = defineSchema({
    messages: defineTable({
        text: v.string(),
    }),
});
`;

describe("insertSchemaExtension", () => {
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

    it("reports no-define-schema when there is no defineSchema call", () => {
        expect.assertions(1);

        const result = insertSchemaExtension("export const schema = {};\n", "ratelimit");

        expect(result).toStrictEqual({ ok: false, reason: "no-define-schema" });
    });
});
