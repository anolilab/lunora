/**
 * Builds `lunora-hostd` as a Node single executable application (plan 458 D3)
 * for the platform this runs on, as `dist/sea/lunora-hostd-{os}-{arch}`. Run it
 * with `node scripts/build-sea.mjs` (or `pnpm run build:sea`).
 *
 * First esbuild bundles `src/bin.ts` and everything it imports into one
 * CommonJS file: Node 24's SEA runs a CommonJS main only, and resolves no
 * module from disk, so everything but `node:` built-ins has to be inside the
 * bundle. `node --experimental-sea-config` turns that file into a preparation
 * blob, and postject injects the blob into a copy of the `node` running this
 * script. The embedded runtime is therefore exactly that `node`: build with the
 * Node release boxes should run (CI pins it). Last, the binary is run with
 * `--version` and must print the package version.
 *
 * Node has no cross-building SEA support, so each platform builds on its own
 * runner (`.github/workflows/hostd-release.yml`).
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { inject } from "postject";

/** Fixed by Node (documented in its SEA guide): the fuse postject flips so the runtime looks for the blob. */
// eslint-disable-next-line no-secrets/no-secrets -- a public constant from the Node.js docs, not a secret
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDirectory = join(packageDirectory, "dist", "sea");
const { version } = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
const platform = `${process.platform}-${process.arch}`;

if (process.platform !== "linux") {
    // macOS needs the binary re-signed and Windows a different resource; boxes are Linux only (W7).
    throw new Error(`lunora-hostd single executables are built for Linux only, not ${process.platform}`);
}

const bundlePath = join(outDirectory, "lunora-hostd.cjs");
const blobPath = join(outDirectory, "lunora-hostd.blob");
const configPath = join(outDirectory, "sea-config.json");
const binaryPath = join(outDirectory, `lunora-hostd-${platform}`);

rmSync(outDirectory, { force: true, recursive: true });
mkdirSync(outDirectory, { recursive: true });

await build({
    bundle: true,
    entryPoints: [join(packageDirectory, "src", "bin.ts")],
    format: "cjs",
    legalComments: "none",
    logLevel: "warning",
    outfile: bundlePath,
    platform: "node",
    target: `node${process.versions.node}`,
});

writeFileSync(
    configPath,
    `${JSON.stringify(
        {
            disableExperimentalSEAWarning: true,
            main: bundlePath,
            output: blobPath,
            // Off: neither buys a measurable start-up win for a bundle this small.
            useCodeCache: false,
            useSnapshot: false,
        },
        undefined,
        4,
    )}\n`,
);

execFileSync(process.execPath, ["--experimental-sea-config", configPath], { stdio: "inherit" });

copyFileSync(process.execPath, binaryPath);
await inject(binaryPath, "NODE_SEA_BLOB", readFileSync(blobPath), { sentinelFuse: SEA_FUSE });

const printed = execFileSync(binaryPath, ["--version"], { encoding: "utf8" }).trim();

if (printed !== version) {
    throw new Error(`${binaryPath} --version printed ${JSON.stringify(printed)}, expected ${JSON.stringify(version)}`);
}

rmSync(blobPath);
rmSync(configPath);
rmSync(bundlePath);

process.stdout.write(`built ${binaryPath} (lunora-hostd ${version}, node ${process.versions.node})\n`);
