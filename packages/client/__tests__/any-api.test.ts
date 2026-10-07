import { describe, expect, it } from "vitest";

import { anyApi } from "../src";

/** The shape codegen's types would give these paths. */
const api = anyApi as unknown as {
    billing: { invoices: { create: object } };
    messages: { send: object };
};

describe("anyApi", () => {
    it("joins a nested path with _ into the dispatch key", () => {
        expect.assertions(3);

        expect(api.messages.send).toStrictEqual({ __lunoraRef: "messages:send" });
        expect(api.billing.invoices.create).toStrictEqual({ __lunoraRef: "billing_invoices:create" });
        // A depth-two node is a reference AND the namespace of a same-named folder.
        expect(JSON.stringify(api.billing.invoices)).toBe('{"__lunoraRef":"billing:invoices"}');
    });

    it("returns the same object for repeated reads of one path", () => {
        expect.assertions(2);

        expect(api.billing.invoices).toBe(api.billing.invoices);
        expect(api.billing.invoices.create).toBe(api.billing.invoices.create);
    });
});
