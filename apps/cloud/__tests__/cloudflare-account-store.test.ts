import { describe, expect, it, vi } from "vitest";

import type { CloudflareAccountTable } from "../src/cloudflare-accounts/store";
import { cloudflareAccountStore, unsealAccount } from "../src/cloudflare-accounts/store";
import { encryptSecret } from "../src/secrets/crypto";

const KEY = "22".repeat(32);
const TOKEN = "cf-token-that-must-never-leak-0123456789";

const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    return {
        _id: "cfa_1",
        accountId: "a".repeat(32),
        cellId: "cell_1",
        ciphertext: "sealed",
        iv: "iv",
        organizationId: "org_1",
        permissions: ["workersScripts", "analytics"],
        workersSubdomain: "acme",
        ...overrides,
    };
};

/** A table over fixed rows, recording every `findMany` it answers. */
const tableOver = (rows: Record<string, unknown>[]) => {
    const findMany = vi.fn<CloudflareAccountTable["findMany"]>(({ where }) =>
        Promise.resolve({ page: rows.filter((candidate) => Object.entries(where).every(([key, value]) => candidate[key] === value)) }),
    );
    const table: CloudflareAccountTable = { findMany, get: (id) => Promise.resolve(rows.find((candidate) => candidate["_id"] === id) ?? null) };

    return { findMany, table };
};

describe(cloudflareAccountStore, () => {
    it("meters a cell's accounts whose token holds Account Analytics Read, in one indexed read", async () => {
        const { findMany, table } = tableOver([
            row(),
            row({ _id: "cfa_2", organizationId: "org_2" }),
            row({ _id: "cfa_3", permissions: ["workersScripts"] }),
            row({ _id: "cfa_4", cellId: "cell_2" }),
        ]);

        const metered = await cloudflareAccountStore(table).meteredFor("cell_1");

        expect(metered.map((account) => account._id)).toStrictEqual(["cfa_1", "cfa_2"]);
        expect(findMany).toHaveBeenCalledTimes(1);
        expect(findMany).toHaveBeenCalledWith({ where: { cellId: "cell_1" } });
    });

    it("unseals a connected account's token, and refuses one that is no longer connected", async () => {
        const sealed = await encryptSecret(KEY, TOKEN);
        const { table } = tableOver([row({ ciphertext: sealed.ciphertext, iv: sealed.iv })]);
        const store = cloudflareAccountStore(table);

        await expect(store.credentials("cfa_1", KEY)).resolves.toStrictEqual({ accountId: "a".repeat(32), apiToken: TOKEN });
        await expect(store.credentials("cfa_gone", KEY)).rejects.toMatchObject({ code: "CONFLICT" });
        await expect(store.lookup("cfa_gone")).resolves.toBeNull();
    });

    it("lists one organization's connections", async () => {
        const { table } = tableOver([row(), row({ _id: "cfa_2", organizationId: "org_2" })]);

        await expect(cloudflareAccountStore(table).ofOrganization("org_2")).resolves.toMatchObject([{ _id: "cfa_2" }]);
    });
});

describe(unsealAccount, () => {
    it("answers the account id with the plaintext token", async () => {
        const sealed = await encryptSecret(KEY, TOKEN);

        await expect(unsealAccount({ accountId: "a".repeat(32), ...sealed }, KEY)).resolves.toStrictEqual({ accountId: "a".repeat(32), apiToken: TOKEN });
    });
});
