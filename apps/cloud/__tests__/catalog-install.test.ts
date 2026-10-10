import { describe, expect, it, vi } from "vitest";

import type { CatalogManifest } from "../src/catalog/artifact";
import type { InstallInput, InstallPorts, SealedSecret, VerifiedArtifact } from "../src/catalog/install";
import { planInstall, runInstall } from "../src/catalog/install";
import okOf from "./catalog-helpers";

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);
const HASH = "a".repeat(64);

/** A verified artifact: a main module, one asset, and a manifest describing them. */
const artifactWith = (manifest: Partial<CatalogManifest> = {}, extra: Record<string, Uint8Array> = {}): VerifiedArtifact => {
    const files = new Map<string, Uint8Array>([["assets/app.css", bytes("body{}")], ["worker.js", bytes("export default {};")], ...Object.entries(extra)]);
    const listed = [...files.keys()].map((path) => {
        return { path, sha256: HASH, size: files.get(path)?.byteLength ?? 0 };
    });

    return {
        files,
        manifest: {
            files: listed,
            format: 1,
            main: "worker.js",
            slug: "counter",
            version: "1.2.0",
            ...manifest,
        },
    };
};

const baseInput = (overrides: Partial<InstallInput> = {}): InstallInput => {
    return {
        artifact: artifactWith({ bindings: [{ binding: "ASSETS", type: "assets" }] }),
        installedBy: "user_1",
        organizationId: "org_1",
        projectId: "proj_1",
        scriptName: "counter-prod",
        slug: "counter",
        values: { secrets: {}, vars: {} },
        ...overrides,
    };
};

const formOf = (form: Partial<NonNullable<CatalogManifest["form"]>>, bindings: unknown[] = [{ binding: "ASSETS", type: "assets" }]) =>
    artifactWith({ bindings, form: { secrets: [], vars: [], ...form } });

/** Ports that succeed, recording every call in order. Override one to make it fail. */
const portsWith = (overrides: Partial<InstallPorts> = {}) => {
    const calls: string[] = [];
    const ports: InstallPorts = {
        abandon: vi.fn<InstallPorts["abandon"]>(async () => {
            calls.push("abandon");
        }),
        claim: vi.fn<InstallPorts["claim"]>(async () => {
            calls.push("claim");

            return { busy: false as const, installId: "inst_1" };
        }),
        finish: vi.fn<InstallPorts["finish"]>(async () => {
            calls.push("finish");
        }),
        inFlight: vi.fn<InstallPorts["inFlight"]>(async () => false),
        mintReleaseKey: vi.fn<InstallPorts["mintReleaseKey"]>(async () => {
            calls.push("mint");

            return { id: "key_1", key: "dk_secret" };
        }),
        release: vi.fn<InstallPorts["release"]>(async () => {
            calls.push("release");

            return { deploymentId: "dep_1", status: "live" as const, url: "https://counter.example.app" };
        }),
        removeSecret: vi.fn<InstallPorts["removeSecret"]>(async () => {
            calls.push("removeSecret");
        }),
        restoreSecret: vi.fn<InstallPorts["restoreSecret"]>(async () => {
            calls.push("restoreSecret");
        }),
        revokeReleaseKey: vi.fn<InstallPorts["revokeReleaseKey"]>(async () => {
            calls.push("revoke");
        }),
        snapshotSecrets: vi.fn<InstallPorts["snapshotSecrets"]>(async (): Promise<SealedSecret[]> => []),
        storeSecret: vi.fn<InstallPorts["storeSecret"]>(async () => {
            calls.push("store");
        }),
        storedSecretNames: vi.fn<InstallPorts["storedSecretNames"]>(async () => [] as string[]),
        ...overrides,
    };

    return { calls, ports };
};

describe(planInstall, () => {
    it("fails with the field the user must fill when a required var is missing", () => {
        const result = planInstall(baseInput({ artifact: formOf({ vars: [{ label: "Site name", name: "SITE_NAME", required: true }] }) }), new Set());

        expect(result).toMatchObject({ field: "SITE_NAME", kind: "invalidInput", ok: false });
    });

    it("falls back to a var's default when the user leaves it blank", () => {
        const result = planInstall(
            baseInput({ artifact: formOf({ vars: [{ default: "Hello", label: "Greeting", name: "GREETING", required: false }] }) }),
            new Set(),
        );

        expect(result).toMatchObject({ ok: true, plan: { request: { manifest: { vars: { GREETING: "Hello" } } } } });
    });

    it("refuses a value the form does not declare", () => {
        const result = planInstall(baseInput({ values: { secrets: {}, vars: { NOT_DECLARED: "x" } } }), new Set());

        expect(result).toMatchObject({ field: "NOT_DECLARED", kind: "invalidInput", ok: false });
    });

    it("generates a secret the project does not have yet, and reports its name only", () => {
        const result = planInstall(
            baseInput({ artifact: formOf({ secrets: [{ generate: "hex-32", label: "Key", name: "SESSION_KEY", required: false }] }) }),
            new Set(),
        );

        const planned = okOf(result);

        expect(planned.plan.generated).toStrictEqual(["SESSION_KEY"]);
        expect(planned.plan.secrets["SESSION_KEY"]).toMatch(/^[0-9a-f]{64}$/u);
    });

    it("keeps a generated secret the project already has, instead of replacing it", () => {
        const result = planInstall(
            baseInput({ artifact: formOf({ secrets: [{ generate: "base64-32", label: "Key", name: "SESSION_KEY", required: false }] }) }),
            new Set(["SESSION_KEY"]),
        );

        const planned = okOf(result);

        expect(planned.plan.kept).toStrictEqual(["SESSION_KEY"]);
        expect(planned.plan.generated).toStrictEqual([]);
        expect(planned.plan.secrets).not.toHaveProperty("SESSION_KEY");
    });

    it("refuses a value over the size limit before it reaches the secret store", () => {
        const result = planInstall(
            baseInput({
                artifact: formOf({ secrets: [{ label: "Token", name: "TOKEN", required: false }] }),
                values: { secrets: { TOKEN: "x".repeat(6000) }, vars: {} },
            }),
            new Set(),
        );

        expect(result).toMatchObject({ field: "TOKEN", kind: "invalidInput", ok: false });
    });

    it("refuses a var that shares a name with a binding", () => {
        const result = planInstall(
            baseInput({ artifact: formOf({ vars: [{ label: "Db", name: "DB", required: false, default: "x" }] }, [{ binding: "DB", type: "d1" }]) }),
            new Set(),
        );

        expect(result).toMatchObject({ field: "DB", kind: "invalidInput", ok: false });
    });

    it("ships the main module as the bundle and every other file as an asset", () => {
        const result = planInstall(baseInput(), new Set());

        const planned = okOf(result);

        expect(Buffer.from(planned.plan.request.bundle, "base64").toString()).toBe("export default {};");
        expect(planned.plan.request.assets?.files).toStrictEqual([{ content: Buffer.from("body{}").toString("base64"), path: "/assets/app.css" }]);
    });

    it("refuses static files with no assets binding to serve them", () => {
        const result = planInstall(baseInput({ artifact: artifactWith({ bindings: [] }) }), new Set());

        expect(result).toMatchObject({ kind: "invalidInput", ok: false });
    });

    it("runs a plain Worker unless the manifest says it is a Lunora app", () => {
        const plain = planInstall(baseInput(), new Set());
        const lunora = planInstall(baseInput({ artifact: artifactWith({ bindings: [{ binding: "ASSETS", type: "assets" }], runtime: "lunora" }) }), new Set());

        expect(plain).toMatchObject({ plan: { request: { runtime: "worker" } } });
        expect(lunora).toMatchObject({ plan: { request: { runtime: "lunora" } } });
    });
});

describe(runInstall, () => {
    it("claims the project, stores the secrets, releases under one key, revokes it and records the install", async () => {
        const { calls, ports } = portsWith();
        const input = baseInput({ values: { secrets: { TOKEN: "s3cret" }, vars: {} } });
        const withSecret = {
            ...input,
            artifact: artifactWith({
                bindings: [{ binding: "ASSETS", type: "assets" }],
                form: { secrets: [{ label: "Token", name: "TOKEN", required: true }], vars: [] },
            }),
        };

        const result = await runInstall(withSecret, ports);

        expect(result).toMatchObject({ deploymentId: "dep_1", ok: true, recorded: true });
        expect(calls).toStrictEqual(["claim", "store", "mint", "release", "revoke", "finish"]);
        expect(ports.claim).toHaveBeenCalledWith({ installedBy: "user_1", slug: "counter", version: "1.2.0" });
    });

    it("never returns a secret value in its result", async () => {
        const { ports } = portsWith();
        const input = baseInput({
            artifact: artifactWith({
                bindings: [{ binding: "ASSETS", type: "assets" }],
                form: { secrets: [{ generate: "hex-32", label: "Key", name: "KEY", required: false }], vars: [] },
            }),
        });

        const result = await runInstall(input, ports);

        expect(JSON.stringify(result)).not.toMatch(/[0-9a-f]{64}/u);
        expect(result).toMatchObject({ generated: ["KEY"], ok: true });
    });

    it("refuses at once when the project is busy, and touches nothing else", async () => {
        const { calls, ports } = portsWith({
            claim: vi.fn<InstallPorts["claim"]>(async () => {
                return { busy: true as const };
            }),
        });

        const result = await runInstall(baseInput(), ports);

        expect(result).toMatchObject({ kind: "busy", ok: false });
        expect(calls).toStrictEqual([]);
    });

    it("abandons the claim and refuses when a release is already in flight", async () => {
        const { calls, ports } = portsWith({ inFlight: vi.fn<InstallPorts["inFlight"]>(async () => true) });

        const result = await runInstall(baseInput(), ports);

        expect(result).toMatchObject({ kind: "busy", ok: false });
        expect(calls).toStrictEqual(["claim", "abandon"]);
        expect(ports.abandon).toHaveBeenCalledWith("inst_1");
    });

    it("puts back a secret that existed before the install, and removes one it created, when storing fails", async () => {
        const previous: SealedSecret = { ciphertext: "old", iv: "iv", name: "TOKEN" };
        const { ports } = portsWith({
            snapshotSecrets: vi.fn<InstallPorts["snapshotSecrets"]>(async () => [previous]),
            storeSecret: vi.fn<InstallPorts["storeSecret"]>(async (name: string) => {
                if (name === "SECOND") {
                    throw new Error("store refused");
                }
            }),
        });
        const input = baseInput({
            artifact: artifactWith({
                bindings: [{ binding: "ASSETS", type: "assets" }],
                form: {
                    secrets: [
                        { label: "Token", name: "TOKEN", required: true },
                        { label: "Second", name: "SECOND", required: true },
                    ],
                    vars: [],
                },
            }),
            values: { secrets: { SECOND: "b", TOKEN: "a" }, vars: {} },
        });

        const result = await runInstall(input, ports);

        expect(result).toMatchObject({ kind: "internal", ok: false });
        expect(ports.restoreSecret).toHaveBeenCalledWith(previous);
        expect(ports.mintReleaseKey).not.toHaveBeenCalled();
    });

    it("rolls the secrets back and abandons the claim when the release does not go live", async () => {
        const { ports } = portsWith({
            release: vi.fn<InstallPorts["release"]>(async () => {
                return { deploymentId: "", error: "the health check failed", status: "failed" as const };
            }),
            storeSecret: vi.fn<InstallPorts["storeSecret"]>(async () => {}),
            snapshotSecrets: vi.fn<InstallPorts["snapshotSecrets"]>(async () => []),
        });
        const input = baseInput({
            artifact: artifactWith({
                bindings: [{ binding: "ASSETS", type: "assets" }],
                form: { secrets: [{ label: "Token", name: "TOKEN", required: true }], vars: [] },
            }),
            values: { secrets: { TOKEN: "a" }, vars: {} },
        });

        const result = await runInstall(input, ports);

        expect(result).toMatchObject({ error: "the health check failed", kind: "internal", ok: false });
        expect(ports.removeSecret).toHaveBeenCalledWith("TOKEN");
        expect(ports.revokeReleaseKey).toHaveBeenCalledWith("inst_1", "key_1");
        expect(ports.abandon).toHaveBeenCalledWith("inst_1");
        expect(ports.finish).not.toHaveBeenCalled();
    });

    it("revokes the key even when the release throws", async () => {
        const { ports } = portsWith({
            release: vi.fn<InstallPorts["release"]>(async () => {
                throw new Error("boom");
            }),
        });

        const result = await runInstall(baseInput(), ports);

        expect(result).toMatchObject({ kind: "internal", ok: false });
        expect(ports.revokeReleaseKey).toHaveBeenCalledWith("inst_1", "key_1");
    });

    it("reports the install as live but unrecorded when its row cannot be marked", async () => {
        const { ports } = portsWith({
            finish: vi.fn<InstallPorts["finish"]>(async () => {
                throw new Error("db down");
            }),
        });

        const result = await runInstall(baseInput(), ports);

        expect(result).toMatchObject({ deploymentId: "dep_1", ok: true, recorded: false });
    });
});
