import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import ownerFieldFromArgsNotAuth from "../src/lints/static/owner-field-from-args-not-auth";
import type { AdvisorOwnerFieldWrite } from "../src/owner-field-writes";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

describe("owner_field_from_args_not_auth", () => {
    // The declaration already enforces it: `applyOwnerScope` requires a verified
    // identity, rejects a disagreeing client value, and stamps the column before
    // `server` runs. Not even INFO: there is no forwarding caller to chase.
    it("reports nothing for an owner-scoped write", () => {
        expect.assertions(1);

        const ownerFieldWrites: AdvisorOwnerFieldWrite[] = [
            {
                scope: { kind: "export", name: "createPost" },
                field: "userId",
                file: "mutators",
                line: 4,
                method: "insert",
                ownerScoped: true,
                visibility: "public",
            },
        ];

        expect(ownerFieldFromArgsNotAuth.run({ ownerFieldWrites, schema: schema() })).toHaveLength(0);
    });

    // The handler checked the written value against the identity before the write.
    it("reports nothing for a write the handler proved equal to the identity", () => {
        expect.assertions(1);

        const ownerFieldWrites: AdvisorOwnerFieldWrite[] = [
            {
                scope: { kind: "export", name: "createPost" },
                field: "organizationId",
                file: "prompts",
                line: 4,
                method: "insert",
                guarded: true,
                visibility: "public",
            },
        ];

        expect(ownerFieldFromArgsNotAuth.run({ ownerFieldWrites, schema: schema() })).toHaveLength(0);
    });

    // A platform-admin procedure: only an admin can reach it, so the write is a breadcrumb at INFO.
    it("reports a platform-admin write at INFO, not ERROR", () => {
        expect.assertions(2);

        const ownerFieldWrites: AdvisorOwnerFieldWrite[] = [
            {
                scope: { kind: "export", name: "setCredits" },
                field: "userId",
                file: "billing",
                line: 9,
                method: "patch",
                adminOnly: true,
                visibility: "public",
            },
        ];
        const findings = ownerFieldFromArgsNotAuth.run({ ownerFieldWrites, schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ level: "INFO", facing: "INTERNAL" });
    });

    it("still reports a public write that is not owner-scoped", () => {
        expect.assertions(2);

        const ownerFieldWrites: AdvisorOwnerFieldWrite[] = [
            { scope: { kind: "export", name: "createPost" }, field: "userId", file: "mutators", line: 4, method: "insert", visibility: "public" },
        ];
        const findings = ownerFieldFromArgsNotAuth.run({ ownerFieldWrites, schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]?.level).toBe("ERROR");
    });

    it("flags one ERROR finding per evidence row with the right cacheKey and detail", () => {
        expect.assertions(4);

        const ownerFieldWrites: AdvisorOwnerFieldWrite[] = [
            { scope: { kind: "export", name: "createPost" }, field: "userId", file: "posts", line: 4, method: "insert" },
            { scope: { kind: "export", name: "movePost" }, field: "tenantId", file: "posts", line: 9, method: "patch" },
        ];
        const findings = ownerFieldFromArgsNotAuth.run({ ownerFieldWrites, schema: schema() });

        expect(findings).toHaveLength(2);
        expect(findings[0]).toMatchObject({
            cacheKey: "owner_field_from_args_not_auth:posts:4:userId",
            level: "ERROR",
            metadata: { exportName: "createPost", field: "userId", method: "insert" },
            name: "owner_field_from_args_not_auth",
        });
        expect(findings[0]?.detail).toContain("userId");
        expect(findings[1]?.cacheKey).toBe("owner_field_from_args_not_auth:posts:9:tenantId");
    });

    it("reports nothing for an internal procedure's write, and still reports the public one", () => {
        expect.assertions(3);

        // An `internalMutation` is not reachable by a caller, so the subject taken
        // from `args` is the correct shape there; its declared visibility is what
        // the lint trusts. The public write beside it is untouched and still blocks.
        const ownerFieldWrites: AdvisorOwnerFieldWrite[] = [
            {
                scope: { kind: "export", name: "saveMemory" },
                field: "userId",
                file: "memory",
                line: 12,
                method: "insert",
                trustedInternal: true,
                visibility: "internal",
            },
            { scope: { kind: "export", name: "createPin" }, field: "userId", file: "pins", line: 20, method: "insert", visibility: "public" },
        ];
        const findings = ownerFieldFromArgsNotAuth.run({ ownerFieldWrites, schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ level: "ERROR", metadata: { exportName: "createPin", visibility: "public" } });
        expect(findings[0]?.detail).toContain("any caller can write rows owned by another user/tenant");
    });

    // A socket, channel or lifecycle handler is `internal` in the registry, but a connected client supplies its payload.
    it("keeps an untrusted internal write, such as a socket handler's, at INFO rather than dropping it", () => {
        expect.assertions(2);

        const ownerFieldWrites: AdvisorOwnerFieldWrite[] = [
            { scope: { kind: "export", name: "onRoomMessage" }, field: "ownerId", file: "room", line: 8, method: "insert", visibility: "internal" },
        ];
        const findings = ownerFieldFromArgsNotAuth.run({ ownerFieldWrites, schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ level: "INFO", metadata: { visibility: "internal" } });
    });

    it("keeps ERROR when the feeder could not attribute a visibility", () => {
        expect.assertions(1);

        // A write outside any recognised procedure gets no visibility. Defaulting
        // to the safe reading (report it) matters more than the false-positive
        // rate here — the alternative silently drops a real IDOR.
        const ownerFieldWrites: AdvisorOwnerFieldWrite[] = [
            { scope: { kind: "export", name: "helper" }, field: "userId", file: "lib", line: 3, method: "insert" },
        ];

        expect(ownerFieldFromArgsNotAuth.run({ ownerFieldWrites, schema: schema() })[0]).toMatchObject({ level: "ERROR" });
    });

    it("finds nothing when the feeder supplies no owner-write evidence", () => {
        expect.assertions(2);

        expect(ownerFieldFromArgsNotAuth.run({ schema: schema() })).toHaveLength(0);
        expect(ownerFieldFromArgsNotAuth.run({ ownerFieldWrites: [], schema: schema() })).toHaveLength(0);
    });
});
