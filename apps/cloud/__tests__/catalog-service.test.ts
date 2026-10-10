import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogForm } from "../src/catalog/artifact";
import { verifyCatalogIndex } from "../src/catalog/index";
import type { InstallPorts, SealedSecret } from "../src/catalog/install";
import { packArtifact } from "../src/catalog/pack";
import type { CatalogDeps, CatalogEnv, InstallAdapters, InstallRequest, InstallTarget } from "../src/catalog/service";
import { INDEX_TTL_MS, installApp, listCatalog, readCatalogConfig, resetCatalogIndexCache } from "../src/catalog/service";
import type { TrustedCatalogKey } from "../src/catalog/signature";
import { ARTIFACT_SIGNING_DOMAIN, INDEX_SIGNING_DOMAIN, sha256Hex, signPayload } from "../src/catalog/signature";

const encoder = new TextEncoder();
const BASE = "https://catalog.example.test/releases";
const INDEX_URL = "https://catalog.example.test/index.json";

/** The verifier's clock: every index in these tests is issued at this instant. */
const NOW = Date.UTC(2026, 9, 10);
const ISSUED = new Date(NOW).toISOString();

interface SigningKey {
    keyId: string;
    privateKey: CryptoKey;
    trusted: TrustedCatalogKey;
}

const generateKey = async (keyId: string): Promise<SigningKey> => {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));

    return { keyId, privateKey: pair.privateKey, trusted: { keyId, publicKey } };
};

const publicKeysEnv = (keys: SigningKey[]): string =>
    JSON.stringify(
        keys.map((key) => {
            return { keyId: key.keyId, publicKey: btoa(String.fromCodePoint(...key.trusted.publicKey)) };
        }),
    );

const signatureFile = async (key: SigningKey, domain: string, bytes: Uint8Array): Promise<Uint8Array> =>
    encoder.encode(JSON.stringify({ keyId: key.keyId, signature: await signPayload(key.privateKey, domain, bytes) }));

const counterFiles = (workerSource = 'export default { fetch: () => new Response("ok") };'): Record<string, Uint8Array> => {
    return {
        "worker.js": encoder.encode(workerSource),
    };
};

const counterForm: CatalogForm = {
    secrets: [{ generate: "hex-32", label: "Signing key", name: "SIGNING_KEY", required: false }],
    vars: [{ default: "Counter", label: "App name", name: "APP_NAME", required: false }],
};

interface Served {
    body: Uint8Array;
    status?: number;
}

interface PublishedApp {
    entry: Record<string, string>;
    manifest: Uint8Array;
    served: Map<string, Served>;
}

/** Pack one app and lay out the files its index entry names, exactly as the publisher does. */
const publishApp = async (
    key: SigningKey,
    input: { files?: Record<string, Uint8Array>; form?: CatalogForm; name: string; slug: string; summary?: string; version: string },
): Promise<PublishedApp> => {
    const packed = await packArtifact({
        files: input.files ?? counterFiles(),
        ...(input.form === undefined ? {} : { form: input.form }),
        keyId: key.keyId,
        main: "worker.js",
        privateKey: key.privateKey,
        slug: input.slug,
        version: input.version,
    });
    const stem = `${BASE}/${input.slug}-${input.version}`;
    const artifactUrl = `${stem}.zip`;
    const manifestUrl = `${stem}.manifest.json`;
    const signatureUrl = `${stem}.manifest.sig`;

    return {
        entry: {
            artifactUrl,
            manifestSha256: await sha256Hex(packed.manifestBytes),
            manifestUrl,
            name: input.name,
            signatureUrl,
            slug: input.slug,
            ...(input.summary === undefined ? {} : { summary: input.summary }),
            version: input.version,
        },
        manifest: packed.manifestBytes,
        served: new Map<string, Served>([
            [artifactUrl, { body: packed.archive }],
            [manifestUrl, { body: packed.manifestBytes }],
            [signatureUrl, { body: encoder.encode(JSON.stringify(packed.signature)) }],
        ]),
    };
};

/** A signed index over `apps`, and the bytes a host would serve for it. */
const publishIndex = async (
    key: SigningKey,
    apps: PublishedApp[],
    options: { indexKey?: SigningKey; issuedAt?: string } = {},
): Promise<Map<string, Served>> => {
    const indexBytes = encoder.encode(JSON.stringify({ apps: apps.map((app) => app.entry), format: 1, issuedAt: options.issuedAt ?? ISSUED }));
    const indexSignature = await signatureFile(options.indexKey ?? key, INDEX_SIGNING_DOMAIN, indexBytes);
    const served = new Map<string, Served>([
        [INDEX_URL, { body: indexBytes }],
        [new URL("index.sig", INDEX_URL).href, { body: indexSignature }],
    ]);

    for (const app of apps) {
        for (const [url, response] of app.served) {
            served.set(url, response);
        }
    }

    return served;
};

const envFor = (keys: SigningKey[]): CatalogEnv => {
    return { CATALOG_INDEX_URL: INDEX_URL, CATALOG_PUBLIC_KEYS: publicKeysEnv(keys) };
};

/** A fake host: serves the given routes and records every URL it was asked for. */
const hostFrom = (routes: Map<string, Served>) => {
    const requests: string[] = [];
    const fetcher = (url: string): Promise<Response> => {
        requests.push(url);

        const route = routes.get(url);

        if (!route) {
            return Promise.resolve(new Response("not found", { status: 404 }));
        }

        return Promise.resolve(new Response(route.body as BodyInit, { status: route.status ?? 200 }));
    };

    return { fetch: fetcher, requests };
};

const catalogDeps = (env: CatalogEnv, fetcher: (url: string) => Promise<Response>, clock: { now: number }): CatalogDeps => {
    return {
        env,
        fetch: fetcher,
        now: () => clock.now,
    };
};

describe(verifyCatalogIndex, () => {
    it("reads the name, summary and https URLs of each entry", async () => {
        const key = await generateKey("catalog-2026");
        const indexBytes = encoder.encode(
            JSON.stringify({
                apps: [
                    {
                        artifactUrl: `${BASE}/counter-1.0.0.zip`,
                        manifestSha256: "a".repeat(64),
                        manifestUrl: `${BASE}/counter-1.0.0.manifest.json`,
                        name: "Counter",
                        signatureUrl: `${BASE}/counter-1.0.0.manifest.sig`,
                        slug: "counter",
                        summary: "A counter.",
                        version: "1.0.0",
                    },
                ],
                format: 1,
                issuedAt: ISSUED,
            }),
        );
        const signature = { keyId: "catalog-2026", signature: await signPayload(key.privateKey, INDEX_SIGNING_DOMAIN, indexBytes) };

        const result = await verifyCatalogIndex({ indexBytes, keys: [key.trusted], now: NOW, signature });

        expect(result).toStrictEqual({
            entries: [
                {
                    artifactUrl: `${BASE}/counter-1.0.0.zip`,
                    manifestSha256: "a".repeat(64),
                    manifestUrl: `${BASE}/counter-1.0.0.manifest.json`,
                    name: "Counter",
                    signatureUrl: `${BASE}/counter-1.0.0.manifest.sig`,
                    slug: "counter",
                    summary: "A counter.",
                    version: "1.0.0",
                },
            ],
            issuedAt: NOW,
            ok: true,
        });
    });

    it.each([
        ["an http manifestUrl", { manifestUrl: "http://catalog.example.test/counter.manifest.json" }, "needs an https manifestUrl"],
        ["a missing name", { name: undefined }, "needs a name"],
        ["a summary over 200 characters", { summary: "x".repeat(201) }, "summary must be at most 200"],
    ])("refuses an index with %s", async (_label, override, message) => {
        const key = await generateKey("catalog-2026");
        const entry: Record<string, unknown> = {
            artifactUrl: `${BASE}/counter-1.0.0.zip`,
            manifestSha256: "b".repeat(64),
            manifestUrl: `${BASE}/counter-1.0.0.manifest.json`,
            name: "Counter",
            signatureUrl: `${BASE}/counter-1.0.0.manifest.sig`,
            slug: "counter",
            version: "1.0.0",
            ...override,
        };
        const indexBytes = encoder.encode(JSON.stringify({ apps: [entry], format: 1, issuedAt: ISSUED }));
        const signature = { keyId: "catalog-2026", signature: await signPayload(key.privateKey, INDEX_SIGNING_DOMAIN, indexBytes) };

        const result = await verifyCatalogIndex({ indexBytes, keys: [key.trusted], now: NOW, signature });

        expect(result).toMatchObject({ error: { code: "INVALID_INDEX" }, ok: false });
        expect(result).toMatchObject({ error: { message: expect.stringContaining(message) } });
    });

    it("refuses an index whose bytes changed after signing", async () => {
        const key = await generateKey("catalog-2026");
        const signed = encoder.encode(JSON.stringify({ apps: [], format: 1, issuedAt: ISSUED }));
        const signature = { keyId: "catalog-2026", signature: await signPayload(key.privateKey, INDEX_SIGNING_DOMAIN, signed) };

        const result = await verifyCatalogIndex({
            indexBytes: encoder.encode(JSON.stringify({ apps: [], format: 1, issuedAt: ISSUED, x: 1 })),
            keys: [key.trusted],
            now: NOW,
            signature,
        });

        expect(result).toMatchObject({ error: { code: "BAD_SIGNATURE" }, ok: false });
    });
});

describe(readCatalogConfig, () => {
    it("is an empty catalog when no index URL is set", () => {
        expect(readCatalogConfig({})).toStrictEqual({ kind: "empty" });
    });

    it("refuses a malformed key list instead of showing an empty catalog", async () => {
        const key = await generateKey("catalog-2026");

        expect(readCatalogConfig({ CATALOG_INDEX_URL: INDEX_URL })).toMatchObject({ kind: "refused" });
        expect(readCatalogConfig({ CATALOG_INDEX_URL: INDEX_URL, CATALOG_PUBLIC_KEYS: "not json" })).toMatchObject({ kind: "refused" });
        expect(readCatalogConfig({ CATALOG_INDEX_URL: INDEX_URL, CATALOG_PUBLIC_KEYS: "[]" })).toMatchObject({ kind: "refused" });
        expect(
            readCatalogConfig({ CATALOG_INDEX_URL: INDEX_URL, CATALOG_PUBLIC_KEYS: JSON.stringify([{ keyId: "x", publicKey: btoa("short") }]) }),
        ).toMatchObject({ kind: "refused" });
        expect(readCatalogConfig(envFor([key]))).toMatchObject({ kind: "ready" });
    });

    it("refuses a plain-http index URL", () => {
        expect(readCatalogConfig({ CATALOG_INDEX_URL: "http://catalog.example.test/index.json", CATALOG_PUBLIC_KEYS: "[]" })).toMatchObject({
            kind: "refused",
        });
    });
});

describe(listCatalog, () => {
    beforeEach(() => {
        resetCatalogIndexCache();
    });

    it("lists verified apps and skips one whose manifest sha does not match, and one with a bad signature", async () => {
        const key = await generateKey("catalog-2026");
        const forger = await generateKey("catalog-2026");
        const good = await publishApp(key, { form: counterForm, name: "Counter", slug: "counter", summary: "A counter.", version: "1.0.0" });
        const tampered = await publishApp(key, { name: "Notes", slug: "notes", version: "2.0.0" });
        const unsigned = await publishApp(key, { name: "Forum", slug: "forum", version: "3.0.0" });

        tampered.served.set(tampered.entry["manifestUrl"] ?? "", { body: encoder.encode('{"format":1}') });
        unsigned.served.set(unsigned.entry["signatureUrl"] ?? "", { body: await signatureFile(forger, ARTIFACT_SIGNING_DOMAIN, unsigned.manifest) });

        const host = hostFrom(await publishIndex(key, [good, tampered, unsigned]));
        const listing = await listCatalog({ ...catalogDeps(envFor([key]), host.fetch, { now: NOW }), installs: async () => [] }, "org_1");

        expect(listing).toStrictEqual({
            apps: [{ form: counterForm, installs: [], name: "Counter", slug: "counter", summary: "A counter.", version: "1.0.0" }],
            ok: true,
            skipped: [
                { reason: "its manifest does not match the sha256 the index names", slug: "notes", version: "2.0.0" },
                { reason: "its manifest signature does not verify", slug: "forum", version: "3.0.0" },
            ],
        });
    });

    it("refuses an index signed by an untrusted key", async () => {
        const key = await generateKey("catalog-2026");
        const other = await generateKey("catalog-2026");
        const app = await publishApp(key, { name: "Counter", slug: "counter", version: "1.0.0" });
        const host = hostFrom(await publishIndex(key, [app], { indexKey: other }));

        const listing = await listCatalog({ ...catalogDeps(envFor([key]), host.fetch, { now: NOW }), installs: async () => [] }, "org_1");

        expect(listing).toMatchObject({ error: expect.stringContaining("failed verification"), ok: false });
    });

    it("serves a verified index from cache for five minutes, and never an expired one it cannot re-verify", async () => {
        const key = await generateKey("catalog-2026");
        const app = await publishApp(key, { name: "Counter", slug: "counter", version: "1.0.0" });
        const routes = await publishIndex(key, [app]);
        const host = hostFrom(routes);
        const clock = { now: NOW };
        const deps = { ...catalogDeps(envFor([key]), host.fetch, clock), installs: async () => [] };

        await listCatalog(deps, "org_1");
        await listCatalog(deps, "org_1");

        expect(host.requests.filter((url) => url === INDEX_URL)).toHaveLength(1);

        clock.now += INDEX_TTL_MS;
        routes.set(INDEX_URL, { body: encoder.encode("{}"), status: 500 });

        const expired = await listCatalog(deps, "org_1");

        expect(expired).toMatchObject({ ok: false });
    });

    it("refuses an index older than one this control plane already served, so a host cannot roll the catalog back", async () => {
        const key = await generateKey("catalog-2026");
        const app = await publishApp(key, { name: "Counter", slug: "counter", version: "1.0.0" });
        const newer = await publishIndex(key, [app], { issuedAt: ISSUED });
        const older = await publishIndex(key, [app], { issuedAt: new Date(NOW - 60 * 60 * 1000).toISOString() });
        const host = hostFrom(newer);
        const clock = { now: NOW };
        const deps = { ...catalogDeps(envFor([key]), host.fetch, clock), installs: async () => [] };

        await expect(listCatalog(deps, "org_1")).resolves.toMatchObject({ ok: true });

        clock.now += INDEX_TTL_MS;
        for (const [url, response] of older) {
            newer.set(url, response);
        }

        await expect(listCatalog(deps, "org_1")).resolves.toMatchObject({ error: expect.stringContaining("older than one"), ok: false });
    });
});

describe(installApp, () => {
    beforeEach(() => {
        resetCatalogIndexCache();
    });

    /** Ports that succeed and record what they did. Override one to make it fail. */
    const portsFor = (overrides: Partial<InstallPorts> = {}) => {
        const calls: Record<string, unknown[]> = { finish: [], revoke: [], store: [] };
        const ports: InstallPorts = {
            abandon: vi.fn(async () => {}),
            claim: vi.fn(async () => {
                return { busy: false as const, installId: "inst_1" };
            }),
            finish: vi.fn(async (installId: string, deploymentId: string) => {
                calls["finish"]?.push({ deploymentId, installId });
            }),
            inFlight: vi.fn(async () => false),
            mintReleaseKey: vi.fn(async () => {
                return { id: "key_1", key: "lk_install_1" };
            }),
            release: vi.fn(async () => {
                return { deploymentId: "dep_1", status: "live" as const, url: "https://acme.example.test" };
            }),
            removeSecret: vi.fn(async () => {}),
            restoreSecret: vi.fn(async () => {}),
            revokeReleaseKey: vi.fn(async (_installId: string, id: string) => {
                calls["revoke"]?.push(id);
            }),
            snapshotSecrets: vi.fn(async (): Promise<SealedSecret[]> => []),
            storeSecret: vi.fn(async (name: string) => {
                calls["store"]?.push(name);
            }),
            storedSecretNames: vi.fn(async () => [] as string[]),
            ...overrides,
        };

        return { calls, ports };
    };

    const target = (value: InstallTarget) => async () => value;

    const request: InstallRequest = { installedBy: "user_1", organizationId: "org_1", projectId: "proj_1", slug: "counter", values: { secrets: {}, vars: {} } };

    const setup = async (routes: Map<string, Served>, key: SigningKey, options: { ports?: Partial<InstallPorts>; target?: InstallTarget } = {}) => {
        const host = hostFrom(routes);
        const { calls, ports } = portsFor(options.ports);
        const adapters: InstallAdapters = { ports, target: target(options.target === undefined ? { scriptName: "acme" } : options.target) };

        return { adapters, calls, host, ports, deps: catalogDeps(envFor([key]), host.fetch, { now: NOW }) };
    };

    it("returns not found for a slug the catalog does not list", async () => {
        const key = await generateKey("catalog-2026");
        const app = await publishApp(key, { name: "Counter", slug: "counter", version: "1.0.0" });
        const { adapters, deps } = await setup(await publishIndex(key, [app]), key);

        const outcome = await installApp(deps, { ...request, slug: "missing" }, adapters);

        expect(outcome).toStrictEqual({ error: "no app named missing is in the catalog", kind: "notFound", ok: false });
    });

    it("installs a verified app: stores its secret, releases under one key, revokes it, and marks the install live", async () => {
        const key = await generateKey("catalog-2026");
        const app = await publishApp(key, { form: counterForm, name: "Counter", slug: "counter", version: "1.0.0" });
        const { adapters, calls, deps } = await setup(await publishIndex(key, [app]), key);

        const outcome = await installApp(deps, { ...request, values: { secrets: {}, vars: { APP_NAME: "Tally" } } }, adapters);

        expect(outcome).toMatchObject({
            deploymentId: "dep_1",
            generated: ["SIGNING_KEY"],
            kept: [],
            ok: true,
            recorded: true,
            url: "https://acme.example.test",
        });
        expect(JSON.stringify(outcome)).not.toMatch(/[0-9a-f]{64}/u);
        expect(calls["store"]).toStrictEqual(["SIGNING_KEY"]);
        expect(calls["revoke"]).toStrictEqual(["key_1"]);
        expect(calls["finish"]).toStrictEqual([{ deploymentId: "dep_1", installId: "inst_1" }]);
    });

    it("refuses an archive whose file bytes differ from the signed hash, before anything is claimed", async () => {
        const key = await generateKey("catalog-2026");
        const app = await publishApp(key, { form: counterForm, name: "Counter", slug: "counter", version: "1.0.0" });
        const original = counterFiles();
        const forged = await packArtifact({
            files: { ...original, "worker.js": encoder.encode("x".repeat(original["worker.js"]?.byteLength ?? 0)) },
            keyId: key.keyId,
            main: "worker.js",
            privateKey: key.privateKey,
            slug: "counter",
            version: "1.0.0",
        });
        app.served.set(app.entry["artifactUrl"] ?? "", { body: forged.archive });
        const { adapters, ports, deps } = await setup(await publishIndex(key, [app]), key);

        const outcome = await installApp(deps, request, adapters);

        expect(outcome).toMatchObject({ code: "HASH_MISMATCH", kind: "verification", ok: false });
        expect(ports.claim).not.toHaveBeenCalled();
        expect(ports.storeSecret).not.toHaveBeenCalled();
    });

    it("reports an upstream failure when a file of the app cannot be fetched", async () => {
        const key = await generateKey("catalog-2026");
        const app = await publishApp(key, { name: "Counter", slug: "counter", version: "1.0.0" });
        app.served.set(app.entry["artifactUrl"] ?? "", { body: new Uint8Array(0), status: 503 });
        const { adapters, deps } = await setup(await publishIndex(key, [app]), key);

        const outcome = await installApp(deps, request, adapters);

        expect(outcome).toMatchObject({ kind: "upstream", ok: false });
    });

    it("reports a conflict and writes nothing when the project has no production alias yet", async () => {
        const key = await generateKey("catalog-2026");
        const app = await publishApp(key, { form: counterForm, name: "Counter", slug: "counter", version: "1.0.0" });
        const { adapters, ports, deps } = await setup(await publishIndex(key, [app]), key, { target: {} });

        const outcome = await installApp(deps, request, adapters);

        expect(outcome).toMatchObject({ kind: "conflict", ok: false });
        expect(ports.storeSecret).not.toHaveBeenCalled();
    });

    it("reports busy and writes nothing when the project already has a release in flight", async () => {
        const key = await generateKey("catalog-2026");
        const app = await publishApp(key, { form: counterForm, name: "Counter", slug: "counter", version: "1.0.0" });
        const { adapters, ports, deps } = await setup(await publishIndex(key, [app]), key, { ports: { inFlight: vi.fn(async () => true) } });

        const outcome = await installApp(deps, request, adapters);

        expect(outcome).toStrictEqual({ error: "this project already has a release in flight", kind: "busy", ok: false });
        expect(ports.storeSecret).not.toHaveBeenCalled();
        expect(ports.mintReleaseKey).not.toHaveBeenCalled();
    });

    it("refuses a required value the user left out, before anything is stored", async () => {
        const key = await generateKey("catalog-2026");
        const form: CatalogForm = { secrets: [{ label: "Stripe key", name: "STRIPE_KEY", required: true }], vars: [] };
        const app = await publishApp(key, { form, name: "Shop", slug: "counter", version: "1.0.0" });
        const { adapters, ports, deps } = await setup(await publishIndex(key, [app]), key);

        const outcome = await installApp(deps, request, adapters);

        expect(outcome).toStrictEqual({ error: "Stripe key is required", field: "STRIPE_KEY", kind: "invalidInput", ok: false });
        expect(ports.storeSecret).not.toHaveBeenCalled();
    });

    it("refuses a manifest that names a different app than the index entry, as a verification failure", async () => {
        const key = await generateKey("catalog-2026");
        const real = await publishApp(key, { name: "Counter", slug: "counter", version: "1.0.0" });
        const impostor = await publishApp(key, { name: "Counter", slug: "other", version: "1.0.0" });
        // The index lists `counter`, but its manifest and archive belong to `other`.
        real.served.set(real.entry["manifestUrl"] ?? "", { body: impostor.manifest });
        const { adapters, deps } = await setup(await publishIndex(key, [real]), key);

        const outcome = await installApp(deps, request, adapters);

        expect(outcome).toMatchObject({ kind: "verification", ok: false });
    });
});
