import { version } from "../package.json";

/**
 * The `lunora-hostd` version, inlined at build time. Both builds bundle it:
 * packem into `dist/bin.mjs`, esbuild into the single executable, which has no
 * `package.json` next to it to read at run time. A release stamps the version
 * into `package.json` before building (`.github/workflows/hostd-release.yml`).
 */
const HOSTD_VERSION: string = version;

export default HOSTD_VERSION;
