import { describe, expect, it } from "vitest";

import { api } from "../lunora/_generated/api";
import { internal } from "../lunora/_generated/internal";
import type { CatalogManifest } from "../src/catalog/artifact";
import type { InstallInput, InstallRelease, VerifiedArtifact } from "../src/catalog/install";
import { runInstall } from "../src/catalog/install";
import { installPorts } from "../src/deploy/routes/catalog";
import { secretsForKind } from "../src/secrets/select";

/**
 * The install's secret rollback, run through the real edge ports against an in-memory
 * `secrets` table that keeps one row per (environment, name), like the real table's
 * unique index. Only the release is replaced, so the test controls whether it goes live.
 */

type Environment = "all" | "dev" | "preview" | "production";

interface Row {
    ciphertext: string;
    environment: Environment;
    id: string;
    iv: string;
    name: string;
}

const HASH = "a".repeat(64);
const encoder = new TextEncoder();

const artifactFor = (secretNames: string[]): VerifiedArtifact => {
    const files = new Map<string, Uint8Array>([["worker.js", encoder.encode("export default {};")]]);
    const manifest: CatalogManifest = {
        files: [{ path: "worker.js", sha256: HASH, size: files.get("worker.js")?.byteLength ?? 0 }],
        form: {
            secrets: secretNames.map((name) => {
                return { label: name, name, required: true };
            }),
            vars: [],
        },
        format: 1,
        main: "worker.js",
        slug: "counter",
        version: "1.2.0",
    };

    return { files, manifest };
};

const inputFor = (secretNames: string[], values: Record<string, string>): InstallInput => {
    return {
        artifact: artifactFor(secretNames),
        installedBy: "user_1",
        organizationId: "org_1",
        projectId: "proj_1",
        scriptName: "counter-prod",
        slug: "counter",
        values: { secrets: values, vars: {} },
    };
};

/** The fake table, behind the context the real `installPorts` reads and writes through. */
const tableWith = (initial: Row[]) => {
    const rows = [...initial];
    let counter = 0;

    const context = {
        runMutation: (reference: unknown, args: Record<string, unknown>): Promise<unknown> => {
            if (reference === api.secrets.store) {
                const environment = (args["environment"] ?? "all") as Environment;
                const existing = rows.find((row) => row.environment === environment && row.name === args["name"]);

                if (existing) {
                    existing.ciphertext = args["ciphertext"] as string;
                    existing.iv = args["iv"] as string;
                } else {
                    counter += 1;
                    rows.push({
                        ciphertext: args["ciphertext"] as string,
                        environment,
                        id: `row_${String(counter)}`,
                        iv: args["iv"] as string,
                        name: args["name"] as string,
                    });
                }

                return Promise.resolve(existing?.id ?? `row_${String(counter)}`);
            }

            if (reference === api.secrets.remove) {
                const index = rows.findIndex((row) => row.id === args["id"]);

                if (index !== -1) {
                    rows.splice(index, 1);
                }

                return Promise.resolve(undefined);
            }

            if (reference === internal.catalog.claimInstall) {
                return Promise.resolve({ busy: false, installId: "inst_1" });
            }

            if (reference === internal.deploy_keys.recordInstallKey) {
                return Promise.resolve("key_1");
            }

            return Promise.resolve(undefined);
        },
        runQuery: (reference: unknown, args: Record<string, unknown>): Promise<unknown> => {
            if (reference === api.secrets.list) {
                return Promise.resolve(
                    rows.map((row) => {
                        return { createdAt: 0, environment: row.environment, id: row.id, name: row.name, updatedAt: 0 };
                    }),
                );
            }

            if (reference === api.secrets.listEncrypted) {
                return Promise.resolve(
                    secretsForKind(rows, "production").map((row) => {
                        return { ...row };
                    }),
                );
            }

            if (reference === internal.secrets.snapshotRows) {
                const names = new Set(args["names"] as string[]);

                // Copies, as a database read returns: a snapshot must not follow later writes.
                return Promise.resolve(
                    rows
                        .filter((row) => names.has(row.name))
                        .map((row) => {
                            return { ...row };
                        }),
                );
            }

            if (reference === internal.catalog.holdsClaim) {
                return Promise.resolve(true);
            }

            if (reference === api.deployments.listByProject) {
                return Promise.resolve([]);
            }

            return Promise.resolve(undefined);
        },
    };

    return { context, rows };
};

/** The real edge ports over `context`, with a release that fails so the rollback runs. */
const failingInstall = async (context: ReturnType<typeof tableWith>["context"], input: InstallInput) => {
    const ports = installPorts(
        context as unknown as Parameters<typeof installPorts>[0],
        "org_1",
        "proj_1",
        "k".repeat(64),
        {} as Parameters<typeof installPorts>[4],
    );

    return runInstall(input, {
        ...ports,
        release: async (_request: InstallRelease) => {
            return { deploymentId: "", error: "the worker did not start", status: "failed" as const };
        },
    });
};

describe("a failed catalog install puts each secret row back where it was", () => {
    it("leaves an all-environment secret as an all row, with no production copy shadowing it", async () => {
        const { context, rows } = tableWith([{ ciphertext: "all-value", environment: "all", id: "row_all", iv: "iv_all", name: "API_KEY" }]);

        const result = await failingInstall(context, inputFor(["API_KEY"], { API_KEY: "new-value" }));

        expect(result).toMatchObject({ ok: false });
        expect(rows.filter((row) => row.name === "API_KEY")).toStrictEqual([
            { ciphertext: "all-value", environment: "all", id: "row_all", iv: "iv_all", name: "API_KEY" },
        ]);
    });

    it("restores a production secret to its old value, and the all row it overrode is left alone", async () => {
        const { context, rows } = tableWith([
            { ciphertext: "all-value", environment: "all", id: "row_all", iv: "iv_all", name: "TOKEN" },
            { ciphertext: "prod-old", environment: "production", id: "row_prod", iv: "iv_prod", name: "TOKEN" },
        ]);

        const result = await failingInstall(context, inputFor(["TOKEN"], { TOKEN: "prod-new" }));

        expect(result).toMatchObject({ ok: false });
        expect(rows.find((row) => row.environment === "all" && row.name === "TOKEN")?.ciphertext).toBe("all-value");
        expect(rows.find((row) => row.environment === "production" && row.name === "TOKEN")).toMatchObject({ ciphertext: "prod-old", iv: "iv_prod" });
        expect(secretsForKind(rows, "production").find((row) => row.name === "TOKEN")?.ciphertext).toBe("prod-old");
    });

    it("removes a secret row the install created, when there was no row for it before", async () => {
        const { context, rows } = tableWith([]);

        const result = await failingInstall(context, inputFor(["SIGNING_KEY"], { SIGNING_KEY: "fresh" }));

        expect(result).toMatchObject({ ok: false });
        expect(rows.some((row) => row.name === "SIGNING_KEY")).toBe(false);
    });
});
