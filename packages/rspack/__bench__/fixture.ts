import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createFixture } from "../__tests__/fixture";

/**
 * The test fixture plus `modules` extra function files, so the per-rebuild
 * work that scales with the size of `lunora/` (the source fingerprint, the
 * ts-morph refresh) is visible instead of rounding to zero on a two-file app.
 */
const createBenchProject = (modules: number): string => {
    // Real path: on macOS `tmpdir()` is a symlink, and Rspack reports a changed
    // file under its real path, which the watch bench matches against.
    const root = realpathSync(createFixture());

    for (let index = 0; index < modules; index += 1) {
        writeFileSync(
            join(root, "lunora", `mod${String(index)}.ts`),
            `import { query } from "./_generated/server";\n\nexport const list${String(index)} = query({ args: {}, handler: async () => [${String(index)}] });\n`,
            "utf8",
        );
    }

    return root;
};

export default createBenchProject;
