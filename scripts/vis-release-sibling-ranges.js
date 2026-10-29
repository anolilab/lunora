/**
 * `vis release` plugin that keeps sibling version RANGES across a release.
 *
 * vis's version step rewrites every `@lunora/*` / `lunorash` specifier of every
 * released sibling, in every dependency field, to `<operator><new version>` —
 * `updateInternalDependencies` only decides which packages cascade, not what is
 * written. A promotion-safe peer range like `>=1.0.0-alpha.76 <2.0.0-0` comes out
 * as `>=1.0.0-alpha.252`: the floor ratchets to the newest alpha on every release
 * and the `<2.0.0-0` ceiling is gone. See scripts/check-sibling-peer-ranges.js for
 * why those ranges exist.
 *
 * So after the version step writes the manifests, every sibling specifier that was
 * a bounded range at HEAD (`>=<floor> <ceiling>`, the deliberate promotion-safe
 * shape) and still admits the version vis just wrote is put back. Anything else —
 * an exact pin, or the `^<version>` vis wrote for one last time — keeps vis's
 * rewrite, so those floors keep rising in lockstep. A range the new version has
 * outgrown (a new prerelease tuple, `1.0.1-alpha.0`) gets that version as its floor
 * and keeps its ceiling; one past its ceiling aborts the release before anything is
 * published, so a range never ships unbounded.
 *
 * Wired up in vis.config.ts as `release.plugins`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import semver from "semver";

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

const isSibling = (name) => name === "lunorash" || name.startsWith("@lunora/");

/**
 * Returns `after` with every sibling specifier that was a bounded range in
 * `before` restored (or re-floored, see above), or `undefined` when nothing
 * needed restoring.
 */
export const restoreSiblingRanges = (before, after) => {
    let changed = false;
    const restored = { ...after };

    for (const field of DEPENDENCY_FIELDS) {
        const previous = before[field];
        const current = after[field];

        if (!previous || !current) {
            continue;
        }

        for (const [name, specifier] of Object.entries(current)) {
            const old = previous[name];

            if (!isSibling(name) || typeof old !== "string" || old === specifier || !old.includes("<") || semver.validRange(old) === null) {
                continue;
            }

            // vis writes `<operator><version>`; the bare version is what the range must admit.
            const written = semver.coerce(specifier, { includePrerelease: true })?.version;

            if (written === undefined) {
                continue;
            }

            let range = old;

            if (!semver.satisfies(written, old)) {
                const ceiling = old.slice(old.indexOf("<"));

                if (!semver.satisfies(written, ceiling, { includePrerelease: true })) {
                    throw new Error(`${name}@${written} is past the ceiling of "${old}" in ${field}; widen the range by hand.`);
                }

                range = `>=${written} ${ceiling}`;
            }

            restored[field] = { ...restored[field], [name]: range };
            changed = true;
        }
    }

    return changed ? restored : undefined;
};

export const keepSiblingRanges = {
    applyDraft: async ({ cwd }) => {
        // Imported here: vis.config.ts loads this module on every vis command.
        const { format, resolveConfig } = await import("prettier");
        const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });

        for (const path of git("diff", "--name-only", "--", "packages/*/package.json").split("\n").filter(Boolean)) {
            const file = join(cwd, path);
            const after = JSON.parse(readFileSync(file, "utf8"));
            const restored = restoreSiblingRanges(JSON.parse(git("show", `HEAD:${path}`)), after);

            if (restored !== undefined) {
                // vis already ran Prettier over this file (`formatChangedFiles`); re-run it so the
                // release commit stays formatted.
                writeFileSync(file, await format(JSON.stringify(restored), { ...(await resolveConfig(file)), filepath: file }));
            }
        }
    },
    name: "keep-sibling-ranges",
};
