/**
 * Guards `registry/<item>/registry.json` `deps` against the versions the
 * `@lunora/*` packages actually resolve.
 *
 * A registry item's `deps` are written verbatim into a *user's* package.json by
 * `lunora add`, so they are the one place in the repo where a version range
 * escapes the workspace without a catalog rewriting it. `workspace:*` entries are
 * resolved for the user at publish time; everything else is a literal a maintainer
 * typed by hand, and nothing had ever checked it.
 *
 * That is how `better-auth` drifted. The catalog moved to `1.7.0-rc.2` while five
 * auth-ui items still said `^1.6.23` and the Auth0/Clerk items `^1.6.14`. A caret
 * range carrying no prerelease tag cannot match a prerelease — npm-semver only
 * admits a prerelease when a comparator shares its [major, minor, patch] tuple —
 * so `pnpm add` quietly resolved the user's own `createAuthClient` import to a 1.6
 * copy while `@lunora/auth` pulled the 1.7 plugins in beside it. Two copies of
 * better-auth, mismatched client/server plugin generics, and a green CI.
 *
 * The rule: if the workspace resolves a dependency, a registry item naming it must
 * ask for a range that admits the resolved version. Versions come from the
 * installed tree rather than from parsing `pnpm-workspace.yaml`, because the
 * installed tree is what a user's `@lunora/*` packages will actually carry —
 * catalog entry, override, and resolution quirks already folded in.
 *
 * Run on every `pnpm install` via the root `postinstall` script.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import semver from "semver";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const registryDir = join(rootDir, "registry");

/**
 * The installed version of `name`, or undefined when the workspace doesn't
 * install it. pnpm's node_modules is strict, so a dependency is only visible from
 * the package that declares it — hence the sweep over every package dir as well
 * as the root.
 *
 * The manifest is read straight off disk rather than through
 * `createRequire(...).resolve(name + "/package.json")`: most modern packages ship
 * an `exports` map that does not list `./package.json`, and better-auth is one of
 * them, so resolution throws ERR_PACKAGE_PATH_NOT_EXPORTED and the whole check
 * silently degrades to "nothing resolved, nothing to verify".
 */
const resolveInstalledVersion = (() => {
    const cache = new Map();
    const searchRoots = [join(rootDir, "node_modules"), ...readdirSync(join(rootDir, "packages")).map((p) => join(rootDir, "packages", p, "node_modules"))];

    return (name) => {
        if (cache.has(name)) {
            return cache.get(name);
        }

        for (const root of searchRoots) {
            try {
                const manifest = JSON.parse(readFileSync(join(root, ...name.split("/"), "package.json"), "utf8"));

                if (typeof manifest.version === "string") {
                    cache.set(name, manifest.version);

                    return manifest.version;
                }
            } catch {
                // Not installed here — try the next package.
            }
        }

        cache.set(name, undefined);

        return undefined;
    };
})();

let hasFailure = false;

for (const entry of readdirSync(registryDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
        continue;
    }

    let item;

    try {
        item = JSON.parse(readFileSync(join(registryDir, entry.name, "registry.json"), "utf8"));
    } catch {
        continue;
    }

    for (const [name, specifier] of Object.entries(item.deps ?? {})) {
        // `workspace:*` is rewritten to a real version when the item is published.
        if (typeof specifier !== "string" || specifier.startsWith("workspace:") || specifier.startsWith("catalog:")) {
            continue;
        }

        const installed = resolveInstalledVersion(name);

        if (installed === undefined || !semver.valid(installed)) {
            continue;
        }

        // `includePrerelease` stays OFF on purpose: this is exactly the strictness
        // a user's `pnpm add` applies, and the point is to reproduce what they will
        // resolve rather than what we wish they would.
        if (semver.satisfies(installed, specifier)) {
            continue;
        }

        hasFailure = true;

        console.error(`❌ registry/${entry.name} depends on "${name}": "${specifier}", which the workspace's installed ${installed} does not satisfy.`);
        console.error(`   \`lunora add ${item.name ?? entry.name}\` writes that range into the user's package.json verbatim,`);
        console.error(`   so they would install a different ${name} than the @lunora/* packages beside it.`);
        console.error(`   Set it to "${installed}" (or a range that admits it).`);
    }
}

if (hasFailure) {
    process.exit(1);
}

console.log("✅ Registry item deps all admit the version the workspace resolves.");
