// Pre-commit ESLint runner for staged files.
//
// ESLint lives in each package (packages/<name>/eslint.config.js), and
// @anolilab/eslint-config decides which plugins to load from the *current
// working directory's* package.json. Running `eslint <paths>` from the repo
// root therefore loads the wrong plugin set for package files (react,
// @tanstack/query, testing-library, … aren't detected), which breaks both the
// rules and any `eslint-disable` directives that reference them.
//
// So we group the staged files by their owning package and run `eslint --fix`
// from inside each package, exactly like the per-package `lint:eslint` task /
// CI. Files outside any package (no eslint.config.js up the tree) are skipped
// — ESLint only runs in packages.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const files = process.argv.slice(2);
const byPackage = new Map();

for (const file of files) {
    const absolute = path.resolve(file);
    const match = absolute.match(/^(.*[/\\]packages[/\\][^/\\]+)[/\\]/u);

    if (!match || !existsSync(path.join(match[1], "eslint.config.js"))) {
        continue;
    }

    const packageDir = match[1];

    if (!byPackage.has(packageDir)) {
        byPackage.set(packageDir, []);
    }

    byPackage.get(packageDir).push(path.relative(packageDir, absolute));
}

let failed = false;

for (const [packageDir, relativeFiles] of byPackage) {
    try {
        execFileSync("pnpm", ["exec", "eslint", "--fix", "--no-warn-ignored", ...relativeFiles], {
            cwd: packageDir,
            stdio: "inherit",
        });
    } catch {
        failed = true;
    }
}

if (failed) {
    process.exit(1);
}
