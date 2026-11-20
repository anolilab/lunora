import { describe, expect, it } from "vitest";

import { api } from "../lunora/_generated/api";
import { internal } from "../lunora/_generated/internal";
import { rollbackInstallWrite } from "../lunora/secrets";
import type { CatalogManifest } from "../src/catalog/artifact";
import type { InstallInput, InstallRelease, VerifiedArtifact } from "../src/catalog/install";
import { runInstall } from "../src/catalog/install";
import { installPorts } from "../src/deploy/routes/catalog";
import { encryptSecret } from "../src/secrets/crypto";
import { openSecret, sealSecret, SECRET_CIPHER_VERSION, secretsForKind } from "../src/secrets/select";

/**
 * The install's secret rollback, run through the real edge ports against an in-memory
 * `secrets` table that keeps one row per (environment, name), like the real table's
 * unique index. Only the release is replaced, so the test controls whether it goes live.
 */

type Environment = "all" | "dev" | "preview" | "production";

interface Row {
    ciphertext: string;
    cipherVersion?: number;
    environment: Environment;
    id: string;
    iv: string;
    name: string;
}

const HASH = "a".repeat(64);
const KEY = "c".repeat(64);
const SCOPE = { organizationId: "org_1", projectId: "proj_1" };

/** A stored row holding `value`, sealed as `store` writes it — or, `legacy`, as a row from before the binding. */
const sealedRow = async (id: string, environment: Environment, name: string, value: string, legacy = false): Promise<Row> => {
    const sealed = legacy ? await encryptSecret(KEY, value) : await sealSecret(KEY, SCOPE, environment, name, value);

    return { ...sealed, environment, id, name };
};

/** The value a row decrypts to, the way a deploy reads it. */
const valueOf = async (row: Row | undefined): Promise<string | undefined> => (row === undefined ? undefined : openSecret(KEY, SCOPE, row));
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

    // The real rollback mutation, run over the same rows, so its compare-and-set is what the test exercises.
    const database = {
        delete: (_table: string, id: string) => {
            rows.splice(
                rows.findIndex((row) => row.id === id),
                1,
            );

            return Promise.resolve();
        },
        patch: (_table: string, id: string, fields: Partial<Row>) => {
            Object.assign(rows.find((row) => row.id === id) ?? {}, fields);

            return Promise.resolve();
        },
        secrets: {
            findMany: ({ where }: { where: { environment: Environment; name: string } }) =>
                Promise.resolve({
                    page: rows
                        .filter((row) => row.environment === where.environment && row.name === where.name)
                        .map((row) => {
                            return { ...row, _id: row.id };
                        }),
                }),
        },
    };

    const context = {
        runMutation: (reference: unknown, args: Record<string, unknown>): Promise<unknown> => {
            if (reference === internal.secrets.rollbackInstallWrite) {
                return Promise.resolve(rollbackInstallWrite.handler({ db: database, now: 1 }, args as never));
            }

            if (reference === api.secrets.store) {
                const environment = (args["environment"] ?? "all") as Environment;
                const existing = rows.find((row) => row.environment === environment && row.name === args["name"]);

                // Like the real `store`, every write is marked bound.
                if (existing) {
                    existing.ciphertext = args["ciphertext"] as string;
                    existing.cipherVersion = SECRET_CIPHER_VERSION;
                    existing.iv = args["iv"] as string;
                } else {
                    counter += 1;
                    rows.push({
                        ciphertext: args["ciphertext"] as string,
                        cipherVersion: SECRET_CIPHER_VERSION,
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

/** The real edge ports over `context`, with a release that fails so the rollback runs. `during` runs while the release is out. */
const failingInstall = async (context: ReturnType<typeof tableWith>["context"], input: InstallInput, during?: () => Promise<void>) => {
    const ports = installPorts(context as unknown as Parameters<typeof installPorts>[0], "org_1", "proj_1", KEY, {} as Parameters<typeof installPorts>[4]);

    return runInstall(input, {
        ...ports,
        release: async (_request: InstallRelease) => {
            await during?.();

            return { deploymentId: "", error: "the worker did not start", status: "failed" as const };
        },
    });
};

/** An owner storing `value` through the real `store` route, as the studio does. */
const ownerStores = async (context: ReturnType<typeof tableWith>["context"], name: string, value: string): Promise<void> => {
    const sealed = await sealSecret(KEY, SCOPE, "production", name, value);

    await context.runMutation(api.secrets.store, { ...SCOPE, ciphertext: sealed.ciphertext, environment: "production", iv: sealed.iv, name });
};

describe("a failed catalog install puts each secret row back where it was", () => {
    it("leaves an all-environment secret as an all row, with no production copy shadowing it", async () => {
        const original = await sealedRow("row_all", "all", "API_KEY", "all-value");
        const { context, rows } = tableWith([{ ...original }]);

        const result = await failingInstall(context, inputFor(["API_KEY"], { API_KEY: "new-value" }));

        expect(result).toMatchObject({ ok: false });
        expect(rows.filter((row) => row.name === "API_KEY")).toStrictEqual([original]);
    });

    it.each([
        ["bound", false],
        ["written before the binding", true],
    ])("restores a %s production secret to its old value, and the all row it overrode is left alone", async (_label, legacy) => {
        const { context, rows } = tableWith([
            await sealedRow("row_all", "all", "TOKEN", "all-value"),
            await sealedRow("row_prod", "production", "TOKEN", "prod-old", legacy),
        ]);

        const result = await failingInstall(context, inputFor(["TOKEN"], { TOKEN: "prod-new" }));

        expect(result).toMatchObject({ ok: false });
        await expect(valueOf(rows.find((row) => row.environment === "all" && row.name === "TOKEN"))).resolves.toBe("all-value");
        await expect(valueOf(rows.find((row) => row.environment === "production" && row.name === "TOKEN"))).resolves.toBe("prod-old");
        await expect(valueOf(secretsForKind(rows, "production").find((row) => row.name === "TOKEN"))).resolves.toBe("prod-old");
    });

    it("removes a secret row the install created, when there was no row for it before", async () => {
        const { context, rows } = tableWith([]);

        const result = await failingInstall(context, inputFor(["SIGNING_KEY"], { SIGNING_KEY: "fresh" }));

        expect(result).toMatchObject({ ok: false });
        expect(rows.some((row) => row.name === "SIGNING_KEY")).toBe(false);
    });

    it("keeps an owner's edit made while the install ran, instead of restoring the old value over it", async () => {
        const { context, rows } = tableWith([await sealedRow("row_prod", "production", "TOKEN", "prod-old")]);

        const result = await failingInstall(context, inputFor(["TOKEN"], { TOKEN: "prod-new" }), () => ownerStores(context, "TOKEN", "owner-edit"));

        expect(result).toMatchObject({ ok: false });
        await expect(valueOf(rows.find((row) => row.environment === "production" && row.name === "TOKEN"))).resolves.toBe("owner-edit");
    });

    it("keeps a secret an owner overwrote while the install ran, though the install created the row", async () => {
        const { context, rows } = tableWith([]);

        const result = await failingInstall(context, inputFor(["SIGNING_KEY"], { SIGNING_KEY: "fresh" }), () =>
            ownerStores(context, "SIGNING_KEY", "owner-value"),
        );

        expect(result).toMatchObject({ ok: false });
        await expect(valueOf(rows.find((row) => row.environment === "production" && row.name === "SIGNING_KEY"))).resolves.toBe("owner-value");
    });
});
