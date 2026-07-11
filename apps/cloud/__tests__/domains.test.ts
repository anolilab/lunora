import { describe, expect, it } from "vitest";

import { createDohResolver, verifyDomain } from "../src/domains/verify";

/** Custom-domain DNS verification (GAPS.md B1). */

const answers =
    (records: Record<string, string[]>): ((name: string, type: "CNAME" | "TXT") => Promise<{ data: string; type: number }[]>) =>
    (name) =>
        Promise.resolve(
            (records[name] ?? []).map((data) => {
                return { data, type: 16 };
            }),
        );

describe(verifyDomain, () => {
    it("verifies when the TXT token matches and the CNAME points at the platform", async () => {
        const result = await verifyDomain("app.example.com", {
            platformTargets: ["lunora.app"],
            resolve: answers({ "app.example.com": ["proj.lunora.app."], "_lunora.app.example.com": ['"tok-1"'] }),
            txtToken: "tok-1",
        });

        expect(result).toStrictEqual({ pointing: true, txtOk: true, verified: true });
    });

    it("fails on a wrong TXT token even when pointing is correct", async () => {
        const result = await verifyDomain("app.example.com", {
            platformTargets: ["lunora.app"],
            resolve: answers({ "app.example.com": ["proj.lunora.app."], "_lunora.app.example.com": ['"other"'] }),
            txtToken: "tok-1",
        });

        expect(result.verified).toBe(false);
        expect(result.txtOk).toBe(false);
    });

    it("fails when the hostname does not point at the platform", async () => {
        const result = await verifyDomain("app.example.com", {
            platformTargets: ["lunora.app"],
            resolve: answers({ "app.example.com": ["elsewhere.net."], "_lunora.app.example.com": ['"tok-1"'] }),
            txtToken: "tok-1",
        });

        expect(result.verified).toBe(false);
        expect(result.pointing).toBe(false);
    });

    it("skips the pointing check when no platform targets are configured", async () => {
        const result = await verifyDomain("app.example.com", {
            resolve: answers({ "_lunora.app.example.com": ['"tok-1"'] }),
            txtToken: "tok-1",
        });

        expect(result.verified).toBe(true);
    });
});

describe(createDohResolver, () => {
    it("parses DoH JSON answers and fails open to an empty set", async () => {
        const okFetch = (() => Promise.resolve(Response.json({ Answer: [{ data: '"tok"', type: 16 }] }))) as unknown as typeof fetch;

        await expect(createDohResolver(okFetch)("_lunora.a.com", "TXT")).resolves.toStrictEqual([{ data: '"tok"', type: 16 }]);

        const downFetch = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch;

        await expect(createDohResolver(downFetch)("a.com", "CNAME")).resolves.toStrictEqual([]);
    });
});
