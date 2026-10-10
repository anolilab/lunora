/**
 * The install core of the app catalog. It turns a verified artifact and the user's
 * values into one release request, then runs one install against injected ports.
 * Nothing here touches Cloudflare or the database; the edge wires the ports.
 *
 * An install is one claimed transaction over a project. It claims the project, stores
 * the secrets the form asks for, releases under a key minted for this install alone,
 * and on any failure puts the project's secrets back the way they were. It never
 * returns a secret value.
 */
import type { ReleaseOutcome, ReleaseRequest } from "../deploy/release-core";
import type { AssetFile, AssetsUpload } from "../provision-contract";
import type { CatalogManifest, FormSecret, FormVariable, SecretGenerator } from "./artifact";

/** Largest value a var or a secret may carry. */
const MAX_VALUE_BYTES = 5 * 1024;

/** Random bytes behind a generated secret. */
const GENERATED_BYTES = 32;

/** Root files the asset layer reads as config rather than serving. */
const RULES_FILES = new Set(["_headers", "_redirects"]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The artifact an install runs, after verification. */
export interface VerifiedArtifact {
    files: Map<string, Uint8Array>;
    manifest: CatalogManifest;
}

/** The user's values, keyed by the form's names. */
export interface InstallValues {
    secrets: Record<string, string>;
    vars: Record<string, string>;
}

export interface InstallInput {
    artifact: VerifiedArtifact;
    installedBy: string;
    organizationId: string;
    projectId: string;
    /** The project's production alias: the Worker the release lands on. */
    scriptName: string;
    slug: string;
    values: InstallValues;
}

/** A stored secret as it was before this install touched it, sealed, so it can be put back. */
export interface SealedSecret {
    ciphertext: string;
    iv: string;
    name: string;
}

/** The release request an install hands the deploy core. */
export type InstallRelease = ReleaseRequest & { assets?: AssetsUpload; bundle: string; kind: "production"; scriptName: string };

/** A plan: the release request, the secrets to store, and which secrets were generated or kept. */
export interface InstallPlan {
    /** Names of secrets generated for this install. Never their values. */
    generated: string[];
    /** Names of secrets the project already had and this install keeps. */
    kept: string[];
    request: InstallRelease;
    /** Secret name → plaintext value, to be stored before the release. */
    secrets: Record<string, string>;
}

/** Why an install did not go live. `busy` and `invalidInput` are the user's to fix; `internal` is not. */
export type InstallFailure = { error: string; field?: string; kind: "busy" | "internal" | "invalidInput"; ok: false };

export type InstallPlanResult = { ok: true; plan: InstallPlan } | InstallFailure;

export type InstallResult = { deploymentId: string; generated: string[]; kept: string[]; ok: true; recorded: boolean; url?: string } | InstallFailure;

/** What an install needs from its edge. Every method is one step; the core orders them. */
export interface InstallPorts {
    /** Release the claim: the install did not go live. */
    abandon: (installId: string) => Promise<void>;
    /** Claim the project for this install. `busy` when another install holds it. */
    claim: (claim: { installedBy: string; slug: string; version: string }) => Promise<{ busy: true } | { busy: false; installId: string }>;
    /** Mark the claim live with its deployment. */
    finish: (installId: string, deploymentId: string) => Promise<void>;
    /** Whether the project already has a release in flight. */
    inFlight: () => Promise<boolean>;
    /** Mint a release key scoped to this install's project. */
    mintReleaseKey: (installId: string) => Promise<{ id: string; key: string }>;
    /** Run the deploy core with the key. */
    release: (request: InstallRelease, key: string) => Promise<ReleaseOutcome>;
    /** Remove a secret the install created. */
    removeSecret: (name: string) => Promise<void>;
    /** Put a secret back exactly as it was. */
    restoreSecret: (secret: SealedSecret) => Promise<void>;
    /** Revoke the key minted for this install. */
    revokeReleaseKey: (installId: string, id: string) => Promise<void>;
    /** The sealed current value of each named secret that exists. */
    snapshotSecrets: (names: string[]) => Promise<SealedSecret[]>;
    /** Names of the project's production secrets. */
    storedSecretNames: () => Promise<string[]>;
    /** Store one secret, plaintext in; the edge seals it. */
    storeSecret: (name: string, value: string) => Promise<void>;
}

const fail = (error: string, field?: string): InstallFailure => {
    return {
        ...(field === undefined ? {} : { field }),
        error,
        kind: "invalidInput",
        ok: false,
    };
};

const toBase64 = (bytes: Uint8Array): string => {
    let binary = "";

    for (let index = 0; index < bytes.length; index += 0x80_00) {
        binary += String.fromCodePoint(...bytes.subarray(index, index + 0x80_00));
    }

    return btoa(binary);
};

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const generateSecret = (generator: SecretGenerator): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(GENERATED_BYTES));

    return generator === "hex-32" ? toHex(bytes) : toBase64(bytes);
};

const byteLength = (value: string): number => encoder.encode(value).byteLength;

/** A binding entry's name and type, when it has the shape the deploy core reads. */
const bindingOf = (entry: unknown): { binding: string; type: unknown } | undefined => {
    if (typeof entry !== "object" || entry === null) {
        return undefined;
    }

    const record = entry as Record<string, unknown>;

    return typeof record["binding"] === "string" ? { binding: record["binding"], type: record["type"] } : undefined;
};

/** A value the user supplied, which must be text. `value` is undefined when it was left out. */
const suppliedText = (supplied: Readonly<Record<string, unknown>>, name: string): { ok: true; value: string | undefined } | InstallFailure => {
    const value = supplied[name];

    if (value !== undefined && typeof value !== "string") {
        return fail(`${name} must be a string`, name);
    }

    return { ok: true, value };
};

/** The names a var may not reuse: every binding except a queue consumer, which is not in the Worker's env. */
const bindingNames = (bindings: unknown[]): Set<string> =>
    new Set(
        bindings
            .map((entry) => bindingOf(entry))
            .filter((entry): entry is { binding: string; type: unknown } => entry !== undefined && entry.type !== "queue_consumer")
            .map((entry) => entry.binding),
    );

/** Resolve the plain vars. A var may not share a name with a binding: a Worker's env holds one value per name. */
const resolveVariables = (
    form: { vars: FormVariable[] },
    supplied: Readonly<Record<string, unknown>>,
    bindings: unknown[],
): { ok: true; vars: Record<string, string> } | InstallFailure => {
    const taken = bindingNames(bindings);
    const variables: Record<string, string> = {};

    for (const item of form.vars) {
        const typed = suppliedText(supplied, item.name);

        if (!typed.ok) {
            return typed;
        }

        const chosen = typed.value === undefined || typed.value === "" ? item.default : typed.value;

        if (chosen === undefined && item.required) {
            return fail(`${item.label} is required`, item.name);
        }

        if (chosen === undefined) {
            continue;
        }

        if (byteLength(chosen) > MAX_VALUE_BYTES) {
            return fail(`${item.name} is over the ${String(MAX_VALUE_BYTES)}-byte limit`, item.name);
        }

        if (taken.has(item.name)) {
            return fail(`${item.name} has the name of a binding; a Worker's env holds one value per name`, item.name);
        }

        variables[item.name] = chosen;
    }

    return { ok: true, vars: variables };
};

/**
 * Resolve the secrets. A supplied value is stored. A secret the project already has
 * and the user did not supply is kept as it is, never regenerated: regenerating would
 * replace a value the app may depend on, and the user cannot see it to restore it.
 */
const resolveSecrets = (
    form: { secrets: FormSecret[] },
    supplied: Readonly<Record<string, unknown>>,
    stored: ReadonlySet<string>,
): { generated: string[]; kept: string[]; ok: true; secrets: Record<string, string> } | InstallFailure => {
    const secrets: Record<string, string> = {};
    const generated: string[] = [];
    const kept: string[] = [];

    for (const item of form.secrets) {
        const typed = suppliedText(supplied, item.name);

        if (!typed.ok) {
            return typed;
        }

        const { value } = typed;

        if (value !== undefined && value !== "") {
            if (byteLength(value) > MAX_VALUE_BYTES) {
                return fail(`${item.name} is over the ${String(MAX_VALUE_BYTES)}-byte limit`, item.name);
            }

            secrets[item.name] = value;
        } else if (stored.has(item.name)) {
            kept.push(item.name);
        } else if (item.generate !== undefined) {
            secrets[item.name] = generateSecret(item.generate);
            generated.push(item.name);
        } else if (item.required) {
            return fail(`${item.label} is required`, item.name);
        }
    }

    return { generated, kept, ok: true, secrets };
};

/** Split the artifact's non-entry files into the static files to serve and the root rules files, which travel as config strings. */
const collectStatic = (
    manifest: CatalogManifest,
    files: Map<string, Uint8Array>,
): { assetFiles: AssetFile[]; ok: true; rules: [string, string][] } | InstallFailure => {
    const assetFiles: AssetFile[] = [];
    const rules: [string, string][] = [];

    for (const file of manifest.files) {
        if (file.path === manifest.main) {
            continue;
        }

        const bytes = files.get(file.path);

        if (bytes === undefined) {
            return fail(`${file.path} is missing from the artifact`);
        }

        if (RULES_FILES.has(file.path)) {
            // Carried as config strings, never served (see `parseAssets` in the deploy core).
            rules.push([file.path, decoder.decode(bytes)]);

            continue;
        }

        if (file.path === ".assetsignore") {
            return fail("the artifact ships .assetsignore, which the asset upload cannot carry");
        }

        assetFiles.push({ content: toBase64(bytes), path: `/${file.path}` });
    }

    return { assetFiles, ok: true, rules };
};

/** The static files as the asset upload carries them, and the root rules files as config. */
const assetUpload = (
    manifest: CatalogManifest,
    files: Map<string, Uint8Array>,
    bindings: unknown[],
): { assets: AssetsUpload | undefined; ok: true } | InstallFailure => {
    const collected = collectStatic(manifest, files);

    if (!collected.ok) {
        return collected;
    }

    const { assetFiles, rules } = collected;
    const hasAssetsBinding = bindings.some((entry) => bindingOf(entry)?.type === "assets");

    if (assetFiles.length === 0 && rules.length > 0) {
        return fail("the artifact ships _headers or _redirects without any static file to serve");
    }

    if (hasAssetsBinding !== assetFiles.length > 0) {
        return fail(
            hasAssetsBinding
                ? "the artifact declares an assets binding but ships no static files"
                : "the artifact ships static files but declares no assets binding",
        );
    }

    if (assetFiles.length === 0) {
        return { assets: undefined, ok: true };
    }

    return { assets: { files: assetFiles, ...(rules.length === 0 ? {} : { config: Object.fromEntries(rules) }) }, ok: true };
};

/**
 * Turn an artifact and the user's values into a release request, or the failure the
 * user needs to see. Every check the deploy core would make on these values happens
 * here first, so a bad value never reaches the secret store.
 */
export const planInstall = (input: InstallInput, stored: ReadonlySet<string>): InstallPlanResult => {
    const { artifact, projectId, scriptName, values } = input;
    const { files, manifest } = artifact;
    const form = manifest.form ?? { secrets: [], vars: [] };
    const bindings = manifest.bindings ?? [];

    const declaredVariables = new Set(form.vars.map((item) => item.name));
    const declaredSecrets = new Set(form.secrets.map((item) => item.name));

    for (const name of Object.keys(values.vars)) {
        if (!declaredVariables.has(name)) {
            return fail(`${name} is not a value this app declares`, name);
        }
    }

    for (const name of Object.keys(values.secrets)) {
        if (!declaredSecrets.has(name)) {
            return fail(`${name} is not a secret this app declares`, name);
        }
    }

    const variables = resolveVariables(form, values.vars, bindings);

    if (!variables.ok) {
        return variables;
    }

    const secrets = resolveSecrets(form, values.secrets, stored);

    if (!secrets.ok) {
        return secrets;
    }

    const main = files.get(manifest.main);

    if (main === undefined) {
        return fail("the artifact's main module is missing");
    }

    const upload = assetUpload(manifest, files, bindings);

    if (!upload.ok) {
        return upload;
    }

    const hasVariables = Object.keys(variables.vars).length > 0;
    const request: InstallRelease = {
        ...(upload.assets === undefined ? {} : { assets: upload.assets }),
        bundle: toBase64(main),
        kind: "production",
        manifest: { bindings, ...(hasVariables ? { vars: variables.vars } : {}) },
        projectId,
        runtime: manifest.runtime ?? "worker",
        scriptName,
    };

    return { ok: true, plan: { generated: secrets.generated, kept: secrets.kept, request, secrets: secrets.secrets } };
};

/** Put the project's secrets back the way the install found them. Best effort: each step is tried. */
const restore = async (ports: InstallPorts, touched: string[], snapshot: Map<string, SealedSecret>): Promise<void> => {
    for (const name of touched) {
        const previous = snapshot.get(name);

        // eslint-disable-next-line no-await-in-loop -- secrets are put back one at a time, in the order they were changed
        await (previous === undefined ? ports.removeSecret(name) : ports.restoreSecret(previous)).catch(() => {});
    }
};

/**
 * Run one install. Claims the project first, so two installs cannot interleave their
 * secrets; plans; stores the secrets; releases under a key minted for this install
 * and revoked whatever the release did; and records the install only once the release
 * is live. A failure after a secret was stored puts the project's secrets back.
 */
export const runInstall = async (input: InstallInput, ports: InstallPorts): Promise<InstallResult> => {
    const claim = await ports.claim({
        installedBy: input.installedBy,
        slug: input.slug,
        version: input.artifact.manifest.version,
    });

    if (claim.busy) {
        return { error: "this project already has a catalog install in progress", kind: "busy", ok: false };
    }

    const { installId } = claim;
    const abandon = (): Promise<void> => ports.abandon(installId).catch(() => {});
    const internal = async (error: string): Promise<InstallFailure> => {
        await abandon();

        return { error, kind: "internal", ok: false };
    };

    let plan: InstallPlan;

    try {
        if (await ports.inFlight()) {
            await abandon();

            return { error: "this project already has a release in flight", kind: "busy", ok: false };
        }

        const planned = planInstall(input, new Set(await ports.storedSecretNames()));

        if (!planned.ok) {
            await abandon();

            return planned;
        }

        plan = planned.plan;
    } catch {
        return internal("could not read the project's current state");
    }

    const names = Object.keys(plan.secrets);
    const touched: string[] = [];
    let snapshot = new Map<string, SealedSecret>();

    try {
        const sealed = await ports.snapshotSecrets(names);

        snapshot = new Map(sealed.map((secret) => [secret.name, secret]));

        for (const name of names) {
            touched.push(name);
            // eslint-disable-next-line no-await-in-loop -- one secret at a time, so a failure knows exactly what changed
            await ports.storeSecret(name, plan.secrets[name] ?? "");
        }
    } catch {
        await restore(ports, touched, snapshot);

        return internal("could not store the install's secrets");
    }

    let minted: { id: string; key: string };

    try {
        minted = await ports.mintReleaseKey(installId);
    } catch {
        await restore(ports, touched, snapshot);

        return internal("could not mint a release key");
    }

    let outcome: ReleaseOutcome;

    try {
        outcome = await ports.release(plan.request, minted.key);
    } catch (error) {
        outcome = { deploymentId: "", error: error instanceof Error ? error.message : "the release did not complete", status: "failed" };
    } finally {
        // A failed revoke must not replace the install's own result; the key expires on its own.
        await ports.revokeReleaseKey(installId, minted.id).catch(() => {});
    }

    if (outcome.status !== "live") {
        await restore(ports, touched, snapshot);
        await abandon();

        return { error: outcome.error ?? "the release did not go live", kind: "internal", ok: false };
    }

    // The release is live: the install stands even if its row cannot be marked.
    let recorded = true;

    await ports.finish(installId, outcome.deploymentId).catch(() => {
        recorded = false;
    });

    return {
        deploymentId: outcome.deploymentId,
        generated: plan.generated,
        kept: plan.kept,
        ok: true,
        recorded,
        ...(outcome.url === undefined ? {} : { url: outcome.url }),
    };
};
