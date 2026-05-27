// This tool is used by the pr ci to determine the packages that need to be published to the pkg-pr-new registry.

// @ts-check
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// `vis affected --sparse-checkout` auto-resolves base/head from the active CI
// provider (GitHub/GitLab/etc.) and prints the affected project roots one per
// line, then exits without executing the target. `build` is just a placeholder
// target; the affected set is computed identically regardless of which target
// is named.
const rawOutput = execFileSync("pnpm", ["exec", "vis", "affected", "build", "--sparse-checkout", "--query", "tag=type:package"], { encoding: "utf8" });

// pnpm prefixes stdout with `[WARN] Unsupported platform...` lines for native-
// binding optional packages on CI runners. Affected paths are emitted one per
// line; filter to lines that look like workspace-relative paths.
const affectedRoots = rawOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("[") && !line.startsWith("WARN"));

// eslint-disable-next-line @typescript-eslint/naming-convention,no-underscore-dangle
const __dirname = dirname(fileURLToPath(import.meta.url));
const rootPath = join(__dirname, "..");

const packages = affectedRoots.map((relativeRoot) => {
    const projectRoot = join(rootPath, relativeRoot);
    const packageJsonPath = join(projectRoot, "package.json");

    if (!existsSync(packageJsonPath)) {
        throw new Error(`package.json not found at ${packageJsonPath} (project root: ${relativeRoot})`);
    }

    return projectRoot;
});

if (packages.length > 0) {
    execFileSync("pnpm", ["exec", "pkg-pr-new", "publish", "--comment=update", "--pnpm", ...packages], { stdio: "inherit" });
} else {
    console.log("No packages to publish");
}
