import { describe, expect, it } from "vitest";

import { ingestKeyCipher, recordIngestKey } from "../lunora/deploy-keys";
import { hashDeployKey } from "../src/deploy/keys";
import { makeCtx } from "./_helpers/fake-ctx";

/**
 * The ingest token a deploy injects lands in the tenant Worker's env, where the
 * code that deploy shipped can read it. Org-wide, it let a CI key scoped to
 * project A ship code that wrote telemetry as every sibling project; the token
 * is the project's own, so it carries the deploying key's reach and no more.
 */

const KEY_A = "production:org_1|project-a-ci";
const KEY_ORG = "production:org_1|org-wide";
const ORG_CIPHER = { ciphertext: "org-wide", iv: "iv0" };
const A_CIPHER = { ciphertext: "project-a", iv: "iv1" };

const store = async (ingestKeys: Record<string, unknown>[] = []) =>
    makeCtx({
        deployKeys: [
            {
                _id: "dk_a",
                capability: "deploy",
                hashedKey: await hashDeployKey(KEY_A),
                name: "ci",
                organizationId: "org_1",
                projectId: "proj_a",
                type: "production",
            },
            { _id: "dk_org", capability: "deploy", hashedKey: await hashDeployKey(KEY_ORG), name: "org", organizationId: "org_1", type: "production" },
            ...ingestKeys,
        ],
        projects: [
            { _id: "proj_a", name: "a", organizationId: "org_1" },
            { _id: "proj_b", name: "b", organizationId: "org_1" },
            { _id: "proj_x", name: "x", organizationId: "org_2" },
        ],
    });

const ingestRow = (id: string, encryptedSecret: { ciphertext: string; iv: string }, projectId?: string) => {
    return {
        _id: id,
        capability: "ingest",
        encryptedSecret,
        hashedKey: `hash_${id}`,
        organizationId: "org_1",
        ...(projectId === undefined ? {} : { projectId }),
    };
};

describe("per-project telemetry ingest keys", () => {
    it("never hands a project's deploy the organization-wide ingest key", async () => {
        expect.assertions(1);

        const { ctx } = await store([ingestRow("ik_org", ORG_CIPHER)]);

        await expect(ingestKeyCipher.handler(ctx, { deployKey: KEY_A, organizationId: "org_1", projectId: "proj_a" } as never)).resolves.toBeNull();
    });

    it("hands a project's deploy that project's ingest key", async () => {
        expect.assertions(1);

        const { ctx } = await store([ingestRow("ik_org", ORG_CIPHER), ingestRow("ik_a", A_CIPHER, "proj_a")]);

        await expect(ingestKeyCipher.handler(ctx, { deployKey: KEY_A, organizationId: "org_1", projectId: "proj_a" } as never)).resolves.toStrictEqual(
            A_CIPHER,
        );
    });

    it("refuses a project-scoped key another project's ingest key, and any key a project of another organization", async () => {
        expect.assertions(2);

        const { ctx } = await store([ingestRow("ik_b", A_CIPHER, "proj_b")]);

        await expect(ingestKeyCipher.handler(ctx, { deployKey: KEY_A, organizationId: "org_1", projectId: "proj_b" } as never)).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
        await expect(
            recordIngestKey.handler(ctx, {
                deployKey: KEY_ORG,
                encryptedSecret: A_CIPHER,
                hashedKey: "h",
                organizationId: "org_1",
                projectId: "proj_x",
            } as never),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("records a minted key against the deploying project", async () => {
        expect.assertions(2);

        const { ctx, ops } = await store([ingestRow("ik_org", ORG_CIPHER)]);

        await expect(
            recordIngestKey.handler(ctx, {
                deployKey: KEY_A,
                encryptedSecret: A_CIPHER,
                hashedKey: "h_a",
                organizationId: "org_1",
                projectId: "proj_a",
            } as never),
        ).resolves.toStrictEqual(A_CIPHER);
        expect(ops).toMatchObject([{ document: { capability: "ingest", hashedKey: "h_a", projectId: "proj_a" }, kind: "insert", table: "deployKeys" }]);
    });
});
