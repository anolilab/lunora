/**
 * Production-artifact guard.
 *
 * Every `@lunora/*` package has both a `build` (`packem build --development`)
 * and a `build:prod` (`packem build --production`) script. Only `build:prod`
 * output is publishable — a development build keeps the React *dev* JSX runtime
 * (`react/jsx-dev-runtime` / `jsxDEV`), dev-only branches, and no `NODE_ENV`
 * folding. Publishing that breaks any consumer whose bundler stubs or drops the
 * dev runtime in a production build: `jsxDEV is not a function` the moment
 * `<LunoraProvider>` mounts.
 *
 * This shipped for real — `@lunora/react@1.0.0-alpha.31` on npm imports
 * `react/jsx-dev-runtime`, because the release workflow ran `build:packages`
 * (→ `build`) and never `build:prod`. The workflow now runs
 * `build:packages:prod`; this script is the belt to that braces, so a
 * reintroduced dev build fails the release instead of reaching the registry.
 *
 *   node scripts/check-dist-production.js            # all packages with a dist/
 *   node scripts/check-dist-production.js react db   # only these directories
 *
 * Root script: `pnpm run dist:check`. Run it AFTER a build.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(rootDir, "packages");

/**
 * Markers that only a development build emits. Each is matched literally against
 * every shipped JS file; `why` is what the reader needs in order to act.
 */
const DEV_MARKERS = [
    { marker: "react/jsx-dev-runtime", why: "React dev JSX runtime import — production bundlers may stub this to undefined" },
    { marker: "jsxDEV", why: "React dev JSX factory call" },
    { marker: "react/jsx-dev-runtime.js", why: "React dev JSX runtime import" },
];

/** Extensions that are executed by a consumer (declarations can't crash at runtime). */
const isRuntimeFile = (name) => /\.(?:mjs|cjs|js)$/.test(name) && !name.endsWith(".d.ts");

const walk = (dir) => {
    const out = [];

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);

        if (entry.isDirectory()) {
            out.push(...walk(full));
        } else if (entry.isFile() && isRuntimeFile(entry.name)) {
            out.push(full);
        }
    }

    return out;
};

const dirExists = (path) => {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
};

const requested = process.argv.slice(2);
const packageDirs = (requested.length > 0 ? requested : readdirSync(packagesDir)).filter((name) => dirExists(join(packagesDir, name)));

const violations = [];
let checkedPackages = 0;
let checkedFiles = 0;

for (const name of packageDirs) {
    const distDir = join(packagesDir, name, "dist");

    if (!dirExists(distDir)) {
        continue;
    }

    checkedPackages += 1;

    for (const file of walk(distDir)) {
        checkedFiles += 1;

        const source = readFileSync(file, "utf8");

        for (const { marker, why } of DEV_MARKERS) {
            if (source.includes(marker)) {
                violations.push({ file: relative(rootDir, file), marker, package: name, why });
                break;
            }
        }
    }
}

if (checkedPackages === 0) {
    console.error("❌ No package dist/ directories found — run a build first (`pnpm run build:packages:prod`).");
    process.exit(1);
}

if (violations.length > 0) {
    console.error(`❌ Development-build artifacts found in ${violations.length} file(s):\n`);

    for (const violation of violations) {
        console.error(`  ${violation.file}`);
        console.error(`    ${violation.marker} — ${violation.why}`);
    }

    console.error("\nThese packages were built with `build` (--development) instead of `build:prod` (--production).");
    console.error("Rebuild with `pnpm run build:packages:prod` before publishing.");
    process.exit(1);
}

console.log(`✅ ${checkedFiles} shipped file(s) across ${checkedPackages} package(s) carry no development-build markers.`);
