/**
 * Keys that are not well-formed UTF-16 on workerd's real storage. SQLite and D1 keep TEXT as UTF-8, so a lone
 * surrogate would be written as U+FFFD and `a\uD800` would share `a�`'s row; each store escapes such keys so
 * both keep their own, and the SQL sweep still recognises and deletes its escaped rows.
 *
 * The store is called directly: the limiter's own key encoding already turns a lone surrogate into ASCII.
 * The sweep config is the `login` fixed window in `test-worker.ts` (60 s period, rate 1), horizon 180 s.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { StoreKind } from "./test-worker";

const NOW = 1_700_000_000_000;
const RETENTION = 180_000;

const freshStub = (label: string) => env.RATE_LIMIT_DO.get(env.RATE_LIMIT_DO.idFromName(`malformed-${label}-${crypto.randomUUID()}`));

describe("ill-formed keys on workerd storage", () => {
    it.each<StoreKind>(["sql", "kv", "d1"])("%s store keeps a lone surrogate apart from its U+FFFD look-alike", async (kind) => {
        expect.assertions(2);

        const stub = freshStub(kind);
        const suffix = crypto.randomUUID();

        await stub.storeSet(kind, `ip:a\uD800${suffix}`, NOW, 1);
        await stub.storeSet(kind, `ip:a�${suffix}`, NOW, 9);

        await expect(stub.storeGet(kind, `ip:a\uD800${suffix}`)).resolves.toStrictEqual({ ts: NOW, value: 1 });
        await expect(stub.storeGet(kind, `ip:a�${suffix}`)).resolves.toStrictEqual({ ts: NOW, value: 9 });
    });

    it("sweeps an expired row whose key was escaped", async () => {
        expect.assertions(2);

        const stub = freshStub("sweep");

        await stub.storeSet("sql", "login:old-\uD800", NOW, 1);

        await expect(stub.storeGet("sql", "login:old-\uD800")).resolves.toStrictEqual({ ts: NOW, value: 1 });

        // Past the horizon: this write sweeps the escaped row and adds its own.
        await stub.sqlConsumeAt("trigger", NOW + RETENTION + 1);

        await expect(stub.storeGet("sql", "login:old-\uD800")).resolves.toBeUndefined();
    });
});
