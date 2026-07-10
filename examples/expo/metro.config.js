// Metro config for the Lunora monorepo. Watches the workspace root so Metro can
// resolve `@lunora/*` workspace packages (symlinked into node_modules by pnpm)
// and the hoisted dependencies at the repo root.
const path = require("node:path");

const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules"), path.resolve(workspaceRoot, "node_modules")];
// pnpm's non-hoisted, symlinked layout: don't walk parent node_modules by name;
// resolve strictly through the paths above so a package resolves to one copy.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
