import { describe, expect, it } from "vitest";

import { createNodeSecretBindings } from "../src/node-secrets";

describe(createNodeSecretBindings, () => {
    it("binds each named secret to its environment variable, read on get()", async () => {
        expect.assertions(2);

        const source: Record<string, string | undefined> = { STRIPE_KEY: "sk_old" };
        const bindings = createNodeSecretBindings(["STRIPE_KEY"], source);

        source.STRIPE_KEY = "sk_new";

        await expect(bindings.STRIPE_KEY?.get()).resolves.toBe("sk_new");
        expect(Object.keys(bindings)).toStrictEqual(["STRIPE_KEY"]);
    });

    it("binds only the names it is given, not every variable in the source", () => {
        expect.assertions(1);

        const bindings = createNodeSecretBindings(["STRIPE_KEY"], { LUNORA_ADMIN_TOKEN: "admin", STRIPE_KEY: "sk" });

        expect(bindings).not.toHaveProperty("LUNORA_ADMIN_TOKEN");
    });

    it.each([
        ["unset", undefined],
        ["empty", ""],
    ])("rejects get() for an %s variable", async (_label, value) => {
        expect.assertions(1);

        const bindings = createNodeSecretBindings(["STRIPE_KEY"], { STRIPE_KEY: value });

        await expect(bindings.STRIPE_KEY?.get()).rejects.toThrow(/STRIPE_KEY/u);
    });

    it.each(["toString", "constructor", "hasOwnProperty"])("rejects %s, which only the prototype carries", async (name) => {
        expect.assertions(1);

        await expect(createNodeSecretBindings([name], {})[name]?.get()).rejects.toThrow(name);
    });

    it("exposes only get, so ctx.secrets does not mistake it for a KV or R2 binding", () => {
        expect.assertions(1);

        const binding = createNodeSecretBindings(["STRIPE_KEY"], { STRIPE_KEY: "sk" }).STRIPE_KEY;

        expect(Object.keys(binding ?? {})).toStrictEqual(["get"]);
    });

    it("reads process.env when no source is given", async () => {
        expect.assertions(1);

        process.env.LUNORA_NODE_SECRETS_TEST = "from-process-env";

        try {
            await expect(createNodeSecretBindings(["LUNORA_NODE_SECRETS_TEST"]).LUNORA_NODE_SECRETS_TEST?.get()).resolves.toBe("from-process-env");
        } finally {
            delete process.env.LUNORA_NODE_SECRETS_TEST;
        }
    });
});
