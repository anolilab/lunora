import { describe, expect, it } from "vitest";

import { anyApi } from "../src";

/** The shape codegen's types would give these paths. */
const api = anyApi as unknown as {
    billing: { invoices: { create: object } };
    messages: { send: object };
    users: { constructor: object; toString: object };
};

describe("anyApi", () => {
    it("joins a nested path with _ into the dispatch key", () => {
        expect.assertions(3);

        expect(api.messages.send).toStrictEqual({ __lunoraRef: "messages:send" });
        expect(api.billing.invoices.create).toStrictEqual({ __lunoraRef: "billing_invoices:create" });
        // A depth-two node is a reference AND the namespace of a same-named folder.
        expect(JSON.stringify(api.billing.invoices)).toBe('{"__lunoraRef":"billing:invoices"}');
    });

    it("resolves an export named like an Object.prototype member in a top-level file", () => {
        expect.assertions(2);

        expect(api.users.toString).toStrictEqual({ __lunoraRef: "users:toString" });
        expect(api.users.constructor).toStrictEqual({ __lunoraRef: "users:constructor" });
    });

    it("ends framework probe chains instead of answering each with another proxy", () => {
        expect.assertions(3);

        const probe = api.messages.send as Record<string, unknown>;

        // Vue's `toRaw` walks `__v_raw` until it is falsy; React reads `$$typeof`.
        expect(Reflect.get(probe, "__v_raw")).toBeUndefined();
        expect(probe.$$typeof).toBeUndefined();
        expect(Reflect.get(anyApi, "__v_isReadonly")).toBeUndefined();
    });

    it("returns the same object for repeated reads of one path", () => {
        expect.assertions(2);

        expect(api.billing.invoices).toBe(api.billing.invoices);
        expect(api.billing.invoices.create).toBe(api.billing.invoices.create);
    });
});
