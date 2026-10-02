/**
 * Prints the entry to commit to `src/trusted-release-keys.ts` for a release
 * signing key (plan 458 W7). Reads the PRIVATE key only to derive its public
 * half; nothing is written. Generate the key with
 * `openssl genpkey -algorithm ed25519 -out hostd-release.pem`, then run
 * `node scripts/release-public-key.mjs hostd-release.pem`. Needs the built
 * `dist/` (`pnpm run build` in this package).
 */
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";

const { releaseKeyId } = await import("../dist/release-verify.mjs");

const [path] = process.argv.slice(2);

if (path === undefined) {
    throw new Error("usage: node scripts/release-public-key.mjs <ed25519-private-key.pem>");
}

const privateKey = createPrivateKey(readFileSync(path, "utf8"));

if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`release keys are Ed25519, not ${String(privateKey.asymmetricKeyType)}`);
}

const publicPem = createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString().trim();
const keyId = releaseKeyId(privateKey);

process.stdout.write(`key id: ${keyId}\n\nAdd to HOSTD_TRUSTED_RELEASE_KEYS in src/trusted-release-keys.ts:\n\n    "${keyId}": \`${publicPem}\`,\n`);
