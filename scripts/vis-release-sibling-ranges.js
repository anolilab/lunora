// vis rewrites every released sibling's specifier to `<operator><new version>`, turning a
// promotion-safe `>=1.0.0-alpha.76 <2.0.0-0` into `>=1.0.0-alpha.252`; this puts the range back.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import semver from "semver";

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

const isSibling = (name) => name === "lunorash" || name.startsWith("@lunora/");

// Exact pins and carets keep vis's rewrite so they rise in lockstep; a version past the ceiling
// throws before anything publishes, so a range never ships unbounded.
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
