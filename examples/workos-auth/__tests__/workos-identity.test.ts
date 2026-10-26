/**
 * The whole path from a WorkOS AuthKit access token to RLS, with no WorkOS
 * account: a locally generated RS256 key stands in for the client's JWKS, tokens
 * are minted in AuthKit's access-token shape, `workos(...)` verifies them exactly
 * as the worker does, and the identity it yields drives the example's real
 * procedures on the in-memory harness.
 */
import { workos } from "@lunora/jwt-auth";
import { lunoraTest } from "@lunora/testing";
import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { add, mine, orgNotes } from "../lunora/notes";
import schema from "../lunora/schema";

const ISSUER = "https://api.workos.com";
const CLIENT_ID = "client_example";
const APP = "http://localhost:5173";
const { privateKey, publicKey } = await generateKeyPair("RS256");
const attacker = await generateKeyPair("RS256");
const resolveIdentity = workos({ clientId: CLIENT_ID, keySet: publicKey });

const sessionToken = async (claims: Record<string, unknown>): Promise<string> =>
    new SignJWT({ client_id: CLIENT_ID, sid: "session_1", ...claims })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime("60s")
        .sign(privateKey);

/** What the worker does per request: verify the bearer, yield the identity (or null). */
const identityFor = async (claims: Record<string, unknown>) =>
    resolveIdentity(new Request(`${APP}/_lunora/rpc`, { headers: { authorization: `Bearer ${await sessionToken(claims)}` } }));

const asCaller = async (t: ReturnType<typeof lunoraTest>, claims: Record<string, unknown>) => {
    const identity = await identityFor(claims);

    expect(identity).not.toBeNull();

    return t.withIdentity(identity as NonNullable<typeof identity>);
};

const org = (role: string) => {
    return { org_id: "org_acme", permissions: role === "admin" ? ["notes:read-org"] : [], role };
};

describe("workos-auth example", () => {
    it("scopes notes to the WorkOS user that wrote them", async () => {
        expect.assertions(5);

        const t = lunoraTest(schema);
        const alice = await asCaller(t, { sub: "user_01ALICE" });
        const bob = await asCaller(t, { sub: "user_01BOB" });

        await alice.mutation(add, { text: "alice's note" });
        await bob.mutation(add, { text: "bob's note" });

        const aliceNotes = await alice.query(mine, {});
        const bobNotes = await bob.query(mine, {});

        expect(aliceNotes.map((note) => note.text)).toStrictEqual(["alice's note"]);
        expect(bobNotes.map((note) => note.text)).toStrictEqual(["bob's note"]);
        await expect(t.query(mine, {})).resolves.toStrictEqual([]);

        t.close();
    });

    it("lets only the org admin read the organization's notes", async () => {
        expect.assertions(4);

        const t = lunoraTest(schema);
        const admin = await asCaller(t, { sub: "user_01ADMIN", ...org("admin") });
        const member = await asCaller(t, { sub: "user_01MEMBER", ...org("member") });

        await member.mutation(add, { text: "member's org note" });

        const adminView = await admin.query(orgNotes, {});

        expect(adminView.map((note) => note.text)).toStrictEqual(["member's org note"]);
        await expect(member.query(orgNotes, {})).resolves.toStrictEqual([]);

        t.close();
    });

    it("refuses a token minted for another client or an unsigned one", async () => {
        expect.assertions(2);

        await expect(identityFor({ client_id: "client_someone_else", sub: "user_01ALICE" })).resolves.toBeNull();

        const forged = await new SignJWT({ sub: "user_01ALICE" })
            .setProtectedHeader({ alg: "RS256" })
            .setIssuer(ISSUER)
            .setExpirationTime("60s")
            .sign(attacker.privateKey);

        await expect(resolveIdentity(new Request(`${APP}/_lunora/rpc`, { headers: { authorization: `Bearer ${forged}` } }))).resolves.toBeNull();
    });
});
