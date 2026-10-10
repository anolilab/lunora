import { describe, expect, it } from "vitest";

import { aliasOfResourceName, tenantResourceName } from "../src/provision-contract";

describe(tenantResourceName, () => {
    it("names a resource <alias>--<binding>, folding case and underscores", () => {
        expect(tenantResourceName("shop", { binding: "USER_FILES", type: "r2" })).toBe("shop--user-files");
    });

    it("never hands two tenants the same name for look-alike alias/binding pairs", () => {
        expect(tenantResourceName("app", { binding: "B_DB", type: "d1" })).not.toBe(tenantResourceName("app-b", { binding: "DB", type: "d1" }));
    });

    it("uses underscores only for Analytics Engine datasets", () => {
        expect(tenantResourceName("my-shop", { binding: "EVENTS", type: "analytics_engine" })).toBe("my_shop__events");
    });

    it("refuses a malformed alias and an over-long name", () => {
        expect(() => tenantResourceName("app--b", { binding: "DB", type: "d1" })).toThrow(/alias/u);
        expect(() => tenantResourceName("Shop", { binding: "DB", type: "d1" })).toThrow(/alias/u);
        expect(() => tenantResourceName("a".repeat(60), { binding: "DB", type: "d1" })).toThrow(/63/u);
    });
});

describe(aliasOfResourceName, () => {
    it("reads the alias back off a resource name", () => {
        expect(aliasOfResourceName(tenantResourceName("app-b", { binding: "__X", type: "queue_producer" }))).toBe("app-b");
    });

    it("answers undefined for names it did not produce", () => {
        expect(aliasOfResourceName("lunora-tenant-queue")).toBeUndefined();
        expect(aliasOfResourceName("app--")).toBeUndefined();
    });
});
