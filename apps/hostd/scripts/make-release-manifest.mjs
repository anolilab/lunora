/**
 * Writes and signs the release manifest for one `lunora-hostd` release, or
 * verifies one (plan 458 W7, §9 Q2). Reads the built `dist/`, so run
 * `pnpm run build` first.
 *
 * Make and sign: set `HOSTD_RELEASE_SIGNING_KEY` to the Ed25519 private key
 * (PKCS#8 PEM) and run `node scripts/make-release-manifest.mjs --version 1.2.3
 * --base-url https://github.com/anolilab/lunora/releases/download/hostd-v1.2.3`,
 * optionally with `--artifacts-dir` (default `dist/sea`), `--release-id`
 * (default `hostd-v` plus the version with every character outside
 * `[A-Za-z0-9_-]` turned into `_`) and `--out` (default
 * `{artifacts-dir}/manifest.json`).
 *
 * `hostd` artifacts are `{artifacts-dir}/lunora-hostd-{platform}`, published at
 * `{base-url}/lunora-hostd-{platform}`. celld and Caddy come from
 * `release-pins.json`. Signing is refused while a pin is still a placeholder,
 * and unless the signature verifies against a key pinned in
 * `src/trusted-release-keys.ts` — so a key no box trusts can never sign a
 * release.
 *
 * Verify an envelope against the pinned keys with `--verify manifest.json`;
 * add `--artifacts-dir` to also check the `hostd` binaries in that directory.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!existsSync(join(packageDirectory, "dist", "release-verify.mjs"))) {
    throw new Error("dist/ is missing: run `pnpm --filter @lunora/hostd run build` first");
}

const { HOSTD_RELEASE_PLATFORMS, HOSTD_TRUSTED_RELEASE_KEYS, validateReleaseManifest } = await import("../dist/release.mjs");
const { signReleaseManifest, verifyArtifact, verifyReleaseManifest } = await import("../dist/release-verify.mjs");

const { values } = parseArgs({
    options: {
        "artifacts-dir": { type: "string" },
        "base-url": { type: "string" },
        out: { type: "string" },
        "release-id": { type: "string" },
        verify: { type: "string" },
        version: { type: "string" },
    },
    strict: true,
});

/** Outside the protocol id alphabet that an `upgrade` job's `releaseId` uses. */
const NON_ID_CHARACTER = /[^\w-]/gu;

/** Ends the script with a message and no stack: every refusal here is an operator error, not a bug. */
class RefusedError extends Error {}

const fail = (message) => {
    throw new RefusedError(message);
};

/**
 * Lists what in the release pins is still a placeholder.
 * @param {unknown} value the pins, or a part of them
 * @param {string} path where `value` sits, JSONPath-ish
 * @returns {string[]} the path of every string that says PLACEHOLDER and every zero size
 */
const findPlaceholders = (value, path = "$") => {
    if (typeof value === "string") {
        return value.includes("PLACEHOLDER") ? [path] : [];
    }

    if (Array.isArray(value)) {
        return value.flatMap((entry, index) => findPlaceholders(entry, `${path}[${String(index)}]`));
    }

    if (typeof value === "object" && value !== null) {
        return Object.entries(value).flatMap(([key, entry]) => {
            if (key === "$comment") {
                return [];
            }

            if (key === "size" && entry === 0) {
                return [`${path}.size`];
            }

            return findPlaceholders(entry, `${path}.${key}`);
        });
    }

    return [];
};

const verifyMode = async (envelopePath) => {
    const verified = verifyReleaseManifest(JSON.parse(readFileSync(envelopePath, "utf8")), HOSTD_TRUSTED_RELEASE_KEYS);

    if (!verified.ok) {
        fail(`${envelopePath}: ${verified.error.code}: ${verified.error.message}`);
    }

    const { manifest } = verified;

    if (values["artifacts-dir"] !== undefined) {
        const directory = resolve(values["artifacts-dir"]);
        const checks = await Promise.all(
            manifest.hostd.artifacts.map(async (artifact) => {
                const file = join(directory, basename(new URL(artifact.url).pathname));

                return { file, result: await verifyArtifact(file, artifact.sha256, artifact.size) };
            }),
        );

        for (const { file, result } of checks) {
            if (!result.ok) {
                fail(`${file}: ${result.error.code}: ${result.error.message}`);
            }

            process.stdout.write(`ok ${file}\n`);
        }
    }

    process.stdout.write(
        `verified ${envelopePath}: release ${manifest.releaseId}, hostd ${manifest.hostd.version}, celld ${manifest.celld.version}, caddy ${manifest.caddy.version}\n`,
    );
};

const makeMode = () => {
    const { version } = values;
    const baseUrl = values["base-url"];

    if (version === undefined || baseUrl === undefined) {
        fail("--version and --base-url are required (or --verify <manifest.json>)");
    }

    const pins = JSON.parse(readFileSync(join(packageDirectory, "release-pins.json"), "utf8"));
    const placeholders = findPlaceholders(pins);

    if (placeholders.length > 0) {
        fail(`release-pins.json still holds placeholders, refusing to sign:\n  ${placeholders.join("\n  ")}`);
    }

    const signingKey = process.env.HOSTD_RELEASE_SIGNING_KEY;

    if (signingKey === undefined || signingKey.trim() === "") {
        fail("HOSTD_RELEASE_SIGNING_KEY is not set (an Ed25519 PKCS#8 PEM)");
    }

    const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    const artifactsDirectory = resolve(values["artifacts-dir"] ?? join(packageDirectory, "dist", "sea"));
    const hostdArtifacts = HOSTD_RELEASE_PLATFORMS.map((platform) => {
        const name = `lunora-hostd-${platform}`;
        const file = join(artifactsDirectory, name);

        if (!existsSync(file)) {
            fail(`${file} is missing: every platform needs its binary`);
        }

        const bytes = readFileSync(file);

        return { platform, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength, url: `${base}/${name}` };
    });

    const manifest = {
        caddy: pins.caddy,
        celld: pins.celld,
        createdAt: new Date().toISOString(),
        hostd: { artifacts: hostdArtifacts, version },
        releaseId: values["release-id"] ?? `hostd-v${version.replaceAll(NON_ID_CHARACTER, "_")}`,
        schema: 1,
    };

    const validated = validateReleaseManifest(manifest);

    if (!validated.ok) {
        fail(`invalid manifest: ${validated.error.message}`);
    }

    const envelope = signReleaseManifest(validated.value, signingKey);
    const check = verifyReleaseManifest(envelope, HOSTD_TRUSTED_RELEASE_KEYS);

    if (!check.ok) {
        fail(
            `signed with ${envelope.keyId}, which does not verify against src/trusted-release-keys.ts (${check.error.code}: ${check.error.message}); commit the public key first (scripts/release-public-key.mjs)`,
        );
    }

    const out = resolve(values.out ?? join(artifactsDirectory, "manifest.json"));

    writeFileSync(out, `${JSON.stringify(envelope, undefined, 4)}\n`);
    process.stdout.write(`wrote ${out}: release ${manifest.releaseId}, signed by ${envelope.keyId}\n`);
};

try {
    await (values.verify === undefined ? makeMode() : verifyMode(values.verify));
} catch (error) {
    if (!(error instanceof RefusedError)) {
        throw error;
    }

    process.stderr.write(`make-release-manifest: ${error.message}\n`);
    process.exitCode = 1;
}
