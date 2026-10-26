// Child process for config-load.bench.ts's cold rows: `node config-load.shim.mjs <root> <serve|import>`.
// Plain Node on the BUILT plugin — the only way to see real module-import cost
// (a TS loader would add its own). `vis run test:bench` builds it first (project.json).
const [root, mode] = process.argv.slice(2);

const { lunora } = await import("../dist/index.mjs");

if (mode === "serve") {
    const { resolveConfig } = await import("vite");

    await resolveConfig({ configFile: false, logLevel: "silent", plugins: [lunora({ projectRoot: root })], root }, "serve");
}
