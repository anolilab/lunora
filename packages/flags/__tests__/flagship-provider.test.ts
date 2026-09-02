import type { FlagshipServerProvider } from "@cloudflare/flagship/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const constructed: unknown[] = [];

// A construction-recording stand-in for the real Flagship provider. Cast to the
// real class type so the typed `vi.mock(import(...))` factory accepts it without
// having to reimplement Flagship's full surface.
class FakeFlagshipProvider {
    public readonly options: unknown;

    public constructor(options: unknown) {
        this.options = options;
        constructed.push(options);
    }
}

vi.mock(import("@cloudflare/flagship/server"), () => {
    return {
        FlagshipServerProvider: FakeFlagshipProvider as unknown as typeof FlagshipServerProvider,
    };
});

// Imported after the mock is registered.
const { flagshipProvider } = await import("../src/providers/flagship");

describe("flagshipProvider", () => {
    beforeEach(() => {
        constructed.length = 0;
    });

    describe("flagshipProvider — binding mode", () => {
        it("resolves the named binding off env and passes it through", () => {
            expect.assertions(2);

            const binding = { evaluate: () => undefined };
            const factory = flagshipProvider({ binding: "FLAGS", cacheTtl: 5000 });

            factory({ FLAGS: binding });

            expect(constructed).toHaveLength(1);
            expect(constructed[0]).toEqual({ binding, cacheTtl: 5000 });
        });

        it("throws a directed error when the binding is absent", () => {
            expect.assertions(1);

            const factory = flagshipProvider({ binding: "FLAGS" });

            expect(() => factory({})).toThrow(/no binding "FLAGS" found/);
        });

        it("throws when the binding is null", () => {
            expect.assertions(1);

            const factory = flagshipProvider({ binding: "FLAGS" });

            expect(() => factory({ FLAGS: null })).toThrow(/no binding "FLAGS" found/);
        });
    });

    describe("flagshipProvider — HTTP mode", () => {
        it("constructs from static config, ignoring env", () => {
            expect.assertions(2);

            const factory = flagshipProvider({ accountId: "acct", appId: "app-abc", authToken: "tok" });

            factory({});

            expect(constructed).toHaveLength(1);
            expect(constructed[0]).toEqual({ accountId: "acct", appId: "app-abc", authToken: "tok" });
        });

        it("resolves an `authToken` thunk against the Worker env", () => {
            expect.assertions(2);

            const factory = flagshipProvider({ accountId: "acct", appId: "app-abc", authToken: (env) => env.FLAGSHIP_TOKEN });

            factory({ FLAGSHIP_TOKEN: "from-env" });

            expect(constructed).toHaveLength(1);
            expect(constructed[0]).toEqual({ accountId: "acct", appId: "app-abc", authToken: "from-env" });
        });

        it("throws when an `authToken` thunk resolves to nothing rather than sending `Bearer undefined`", () => {
            expect.assertions(2);

            const factory = flagshipProvider({ appId: "app-abc", authToken: (env) => env.FLAGSHIP_TOKEN });

            expect(() => factory({})).toThrow(/`authToken` resolved to an empty or non-string value/);
            expect(constructed).toHaveLength(0);
        });

        it("constructs from a full endpoint override", () => {
            expect.assertions(2);

            const factory = flagshipProvider({ endpoint: "https://flags.example.com/eval" });

            factory({});

            expect(constructed).toHaveLength(1);
            expect(constructed[0]).toEqual({ endpoint: "https://flags.example.com/eval" });
        });

        it("throws a directed error when neither appId nor endpoint is set", () => {
            expect.assertions(2);

            expect(() => flagshipProvider({})).toThrow(/requires either `appId`.*or `endpoint`/s);
            expect(constructed).toHaveLength(0);
        });

        it("throws when appId and endpoint are both set (mutually exclusive)", () => {
            expect.assertions(2);

            expect(() => flagshipProvider({ appId: "app-abc", endpoint: "https://flags.example.com/eval" })).toThrow(/mutually exclusive/);
            expect(constructed).toHaveLength(0);
        });
    });
});
