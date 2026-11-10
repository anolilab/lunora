import { describe, expect, it } from "vitest";

import emitServer from "../src/emit/server";
import { emitApp } from "../src/emit-app";
import baseOptions from "./emit-app-options";

const CLAIMS = ["plan", "seats"];

describe("emitApp wires the declared user-column claims into both auth resolvers", () => {
    it("passes the claim list to the object route and to the D1 resolver", () => {
        expect.assertions(2);

        const app = emitApp({ ...baseOptions, hasAuth: true, authClaims: CLAIMS });

        expect(app).toContain(`claims: ["plan","seats"],`);
        expect(app).toContain(`resolveSessionIdentity(auth, (request as Request).headers, ["plan","seats"])`);
    });

    it("keeps the no-claims calls unchanged when the app declares none", () => {
        expect.assertions(3);

        const app = emitApp({ ...baseOptions, hasAuth: true, authClaims: [] });

        expect(app).not.toContain("claims: [");
        expect(app).toContain("resolveSessionIdentity(auth, (request as Request).headers);");
        expect(app).toBe(emitApp({ ...baseOptions, hasAuth: true }));
    });
});

describe("emitServer types ctx.auth from the declared claims", () => {
    const CONTRACT = { exportName: "identity" };
    const SCHEMA = { tables: [], vectorIndexes: [] };
    const CLAIM_TYPES = [
        { name: "plan", type: "string" as const, writable: true },
        { name: "seats", type: "number" as const, writable: false },
    ];

    it("types the identity from SessionIdentity when claims exist with no contract", () => {
        expect.assertions(3);

        const server = emitServer({ authClaims: CLAIM_TYPES, schema: SCHEMA });

        expect(server).toContain("export type AuthClaims = {\n    plan?: string;\n    seats?: number;\n};");
        expect(server).toContain("export type Identity = SessionIdentity & AuthClaims;");
        expect(server).toContain('import type { SessionIdentity } from "@lunora/auth";');
    });

    it("adds the claims to a declared contract without overriding a key the contract declares", () => {
        expect.assertions(2);

        const server = emitServer({ authClaims: CLAIM_TYPES, identity: CONTRACT, schema: SCHEMA });

        expect(server).toContain(
            "type DeclaredIdentity = InferIdentity<typeof lunoraIdentityContract.identity>;\nexport type Identity = DeclaredIdentity & Omit<AuthClaims, keyof DeclaredIdentity>;",
        );
        expect(server).toContain("export type AuthClaims = {");
    });

    it("leaves the contract-only identity byte-identical when no claims are declared", () => {
        expect.assertions(3);

        const server = emitServer({ identity: CONTRACT, schema: SCHEMA });

        expect(server).toContain("export type Identity = InferIdentity<typeof lunoraIdentityContract.identity>;");
        expect(server).not.toContain("AuthClaims");
        expect(server).not.toContain("SessionIdentity");
    });
});
