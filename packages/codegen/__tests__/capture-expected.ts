import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCodegen } from "../src/index";
import { GOLDEN_FIXTURES, GOLDEN_OUTPUTS, makeFixtureWorkdir } from "./golden-fixtures";

const here = dirname(fileURLToPath(import.meta.url));

for (const [fixture, goldenDirectory] of GOLDEN_FIXTURES) {
    const fixtureRoot = join(here, "fixtures", fixture);
    const workdir = makeFixtureWorkdir(fixtureRoot);

    // `lint: false` keeps `LUNORA_ADVISORIES` empty in the captured fixture so the
    // snapshot stays decoupled from advisor behaviour — matches the snapshot test.
    const result = runCodegen({ lint: false, projectRoot: workdir });
    const expectedDirectory = join(fixtureRoot, goldenDirectory);

    mkdirSync(expectedDirectory, { recursive: true });

    for (const [file, key] of GOLDEN_OUTPUTS) {
        writeFileSync(join(expectedDirectory, file), result.generated[key], "utf8");
    }

    // The workdir lives under `__tests__/fixtures` (see `makeFixtureWorkdir`), so
    // leaving it behind would show up as an untracked tree in the repo.
    rmSync(workdir, { force: true, recursive: true });

    // eslint-disable-next-line no-console
    console.log("Wrote expected fixtures to", expectedDirectory);
}
