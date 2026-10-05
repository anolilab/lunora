/**
 * Moves the `hostd-latest` pointer forward to a release just published (plan
 * 458 W7). `install.sh` without `--version` reads `latest.json`, an asset of
 * the GitHub Release `hostd-latest`, instead of searching the repository's
 * release list — in a monorepo that publishes a release per package per
 * version, `hostd-v*` releases fall off the first page of that list at once.
 * It holds `{"schema": 1, "stable": "1.2.0" | null, "prerelease": "1.3.0-alpha.2"}`.
 *
 * `stable` is the newest release without a pre-release part, for boxes on a
 * stable release; `prerelease` is the newest release of any kind, for boxes on
 * a pre-release. Each only ever moves forward (`latest-pointer.mjs`, ordered by
 * `compareReleaseVersions` from the built `@lunora/hostd/release`), so a
 * release published late can never pull boxes back. The pointer is a hint,
 * not a trust root: a box verifies the manifest it leads to as always, and
 * refuses a release older than its own.
 *
 * Run: `node scripts/update-latest-pointer.mjs --version 1.2.0 [--current latest.json] --out latest.json`.
 *
 * Reads the built `dist/`, so run `pnpm run build` first.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import nextLatestPointer from "./latest-pointer.mjs";

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!existsSync(join(packageDirectory, "dist", "release.mjs"))) {
    throw new Error("dist/ is missing: run `pnpm --filter @lunora/hostd run build` first");
}

const { compareReleaseVersions } = await import("../dist/release.mjs");

const { values } = parseArgs({
    options: {
        current: { type: "string" },
        out: { type: "string" },
        version: { type: "string" },
    },
    strict: true,
});

if (values.version === undefined || values.out === undefined) {
    throw new Error("usage: update-latest-pointer.mjs --version <version> [--current latest.json] --out latest.json");
}

const current = values.current !== undefined && existsSync(values.current) ? JSON.parse(readFileSync(values.current, "utf8")) : {};
const next = nextLatestPointer(current, values.version, compareReleaseVersions);

writeFileSync(values.out, `${JSON.stringify(next)}\n`);
process.stdout.write(`hostd-latest: stable ${String(next.stable)}, prerelease ${next.prerelease}\n`);
