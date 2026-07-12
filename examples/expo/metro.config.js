// Metro config for the Lunora monorepo. Watches the workspace root so Metro can
// resolve `@lunora/*` workspace packages (symlinked into node_modules by pnpm)
// and the hoisted dependencies at the repo root.
const path = require("node:path");

const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
    path.resolve(projectRoot, "node_modules"),
    path.resolve(workspaceRoot, "node_modules"),
    // pnpm nests a package's own deps under `.pnpm/<pkg>@ver/node_modules` and
    // never symlinks them to the public root. Third-party packages with many
    // runtime deps (notably `expo`, which pulls expo-asset/font/keep-awake/…)
    // therefore aren't resolvable from the two public roots above. pnpm's virtual
    // store also mirrors the full transitive closure into this single hoisted
    // dir, so add it as a LAST-resort path. It is searched after the app and
    // workspace roots, so singletons (react, react-native) still resolve to their
    // canonical copy there; this only backstops deep transitive deps.
    path.resolve(workspaceRoot, "node_modules/.pnpm/node_modules"),
];
// pnpm's non-hoisted, symlinked layout: don't walk parent node_modules by name;
// resolve strictly through the paths above so a package resolves to one copy.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
