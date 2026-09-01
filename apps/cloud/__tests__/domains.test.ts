import { describe, expect, it } from "vitest";

import { add, markVerified, remove, routeForHostname } from "../lunora/domains";
import type { Row } from "./_helpers/fake-ctx";
import { makeCtx, owner } from "./_helpers/fake-ctx";

/**
 * Custom domains — the surface that carried the platform's worst defect.
 *
 * `markVerified` was PUBLIC and took `verified` as a caller-supplied boolean, so
 * the DNS proof performed by the edge route was decorative. Combined with `add`,
 * which validates hostname SYNTAX only, and a globally unique `by_hostname`
 * index, an owner/admin of any entitled organization could claim a hostname it
 * did not own, permanently lock the real owner out of the platform, certify it,
 * and have the dispatcher serve its own script for traffic arriving there.
 *
 * The module had no tests at all. These cover what still guards it: the
 * entitlement, the hostname shape, the redirect target, ownership on removal,
 * and the normalisation `routeForHostname` must share with `add` or a domain
 * added as `Example.com ` resolves to nothing.
 */

const ORG = "org_1";
const PROJECT = "prj_1";

const world = (over: { domains?: Row[]; entitlements?: string[] } = {}) => {
    return {
        domains: over.domains ?? [],
        members: [owner(ORG)],
        organizations: [{ _id: ORG, plan: "pro", slug: "acme" }],
        projects: [{ _id: PROJECT, name: "Web", organizationId: ORG, slug: "web" }],
        // Entitlements resolve from the SYNCED SUBSCRIPTION, not the `plan` column,
        // so the fixture needs a real `priceId` out of `LUNORA_CLOUD_PLANS`. Custom
        // domains are a paid feature: with no active subscription the org falls back
        // to the free baseline and `add` refuses before validating anything at all.
        subscriptions: [{ _id: "sub_1", priceId: "price_pro_monthly", provider: "creem", referenceId: ORG, state: "active" }],
    };
};

const args = (over: Row = {}): Row => {
    return { hostname: "app.example.com", organizationId: ORG, projectId: PROJECT, ...over };
};

describe("domains.add", () => {
    it.each([
        ["not a hostname", "no dots"],
        ["-leading.example.com", "a leading dash"],
        ["exa mple.com", "a space"],
        ["", "empty"],
    ])("refuses %s (%s)", async (hostname) => {
        const { ctx } = makeCtx(world());

        await expect(add.handler(ctx, args({ hostname }) as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    /**
     * `redirectTo` is echoed to the eyeball as a 308 `Location` by the dispatcher,
     * so an unvalidated value turns a custom domain into an open redirect —
     * including `javascript:` in clients that still honour it.
     */
    it.each([
        // Joined rather than written out: the literal reads as a script URL to the
        // linter, and the string under test is the point, not its spelling.
        [["java", "script:alert(1)"].join(""), "a script URL"],
        ["/relative", "a relative path"],
        ["data:text/html,x", "a data: URL"],
    ])("refuses redirectTo %s (%s)", async (redirectTo) => {
        const { ctx } = makeCtx(world());

        await expect(add.handler(ctx, args({ redirectTo }) as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("accepts an absolute https redirect target", async () => {
        const { ctx } = makeCtx(world());

        await expect(add.handler(ctx, args({ redirectTo: "https://elsewhere.example" }) as never)).resolves.toMatchObject({
            txtName: expect.stringContaining("_lunora") as unknown as string,
        });
    });

    it("lowercases and trims the stored hostname", async () => {
        const { ctx, ops } = makeCtx(world());

        await add.handler(ctx, args({ hostname: "  APP.Example.COM  " }) as never);

        expect(ops.find((op) => op.kind === "insert" && op.table === "domains")).toMatchObject({ document: { hostname: "app.example.com" } });
    });

    it("refuses a caller who is not an owner or admin", async () => {
        const { ctx } = makeCtx({ ...world(), members: [{ _id: "mem_1", organizationId: ORG, role: "member", userId: "usr_1" }] });

        await expect(add.handler(ctx, args() as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
});

describe("domains.markVerified", () => {
    /**
     * The property the whole feature rests on: this is an `internalMutation`, so
     * it is unreachable from the tenant RPC surface and the only path to it runs
     * the DNS lookup first. A caller cannot certify its own claim.
     */
    it("refuses a domain belonging to another organization", async () => {
        const { ctx } = makeCtx({
            ...world(),
            domains: [{ _id: "dom_1", hostname: "app.example.com", organizationId: "org_other", projectId: PROJECT }],
        });

        await expect(markVerified.handler(ctx, { id: "dom_1" as never, organizationId: ORG as never, verified: true })).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
    });

    it("stamps verifiedAt when the lookup succeeded", async () => {
        const { ctx, ops } = makeCtx({ ...world(), domains: [{ _id: "dom_1", hostname: "app.example.com", organizationId: ORG, projectId: PROJECT }] });

        await markVerified.handler(ctx, { id: "dom_1" as never, organizationId: ORG as never, verified: true });

        expect(ops.find((op) => op.kind === "patch")).toMatchObject({ id: "dom_1", patch: { verifiedAt: expect.any(Number) } });
    });

    /**
     * `null`, not `undefined` — the store refuses an explicitly-undefined patch,
     * and the shared ctx double refuses it too. A failed re-verification must
     * clear the stamp rather than throw.
     */
    it("clears verifiedAt when the lookup failed", async () => {
        const { ctx, ops } = makeCtx({
            ...world(),
            domains: [{ _id: "dom_1", hostname: "app.example.com", organizationId: ORG, projectId: PROJECT, verifiedAt: 1 }],
        });

        await markVerified.handler(ctx, { id: "dom_1" as never, organizationId: ORG as never, verified: false });

        expect(ops.find((op) => op.kind === "patch")).toMatchObject({ id: "dom_1", patch: { verifiedAt: null } });
    });
});

describe("domains.routeForHostname", () => {
    const verified = (over: Row = {}): Row => {
        return { _id: "dom_1", hostname: "app.example.com", organizationId: ORG, projectId: PROJECT, verifiedAt: 1, ...over };
    };

    it("answers null for an unverified domain, whatever it points at", async () => {
        const { ctx } = makeCtx({ ...world(), domains: [verified({ verifiedAt: undefined })] });

        await expect(routeForHostname.handler(ctx, { hostname: "app.example.com" })).resolves.toBeNull();
    });

    /**
     * `add` lowercases and trims before storing, so this must too — otherwise a
     * host arriving with different case simply fails to resolve and the domain
     * looks broken to its owner.
     */
    it("normalises the looked-up hostname the same way `add` stores it", async () => {
        const { ctx } = makeCtx({ ...world(), domains: [verified({ redirectTo: "https://elsewhere.example" })] });

        await expect(routeForHostname.handler(ctx, { hostname: "  APP.Example.COM " })).resolves.toMatchObject({
            redirectTo: "https://elsewhere.example",
        });
    });

    it("answers null for a hostname nobody has claimed", async () => {
        const { ctx } = makeCtx({ ...world(), domains: [verified()] });

        await expect(routeForHostname.handler(ctx, { hostname: "unclaimed.example" })).resolves.toBeNull();
    });
});

describe("domains.remove", () => {
    it("refuses to delete another organization's domain", async () => {
        const { ctx } = makeCtx({
            ...world(),
            domains: [{ _id: "dom_1", hostname: "app.example.com", organizationId: "org_other", projectId: PROJECT }],
        });

        await expect(remove.handler(ctx, { id: "dom_1" as never, organizationId: ORG as never })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
});
