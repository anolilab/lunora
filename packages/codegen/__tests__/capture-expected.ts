import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCodegen } from "../src/index";
import { copyFixtureApp, GOLDEN_FIXTURES, GOLDEN_OUTPUTS } from "./golden-fixtures";

const here = dirname(fileURLToPath(import.meta.url));

for (const [fixture, goldenDirectory] of GOLDEN_FIXTURES) {
    const fixtureRoot = join(here, "fixtures", fixture);
    const workdir = mkdtempSync(join(tmpdir(), "lunora-capture-"));

    copyFixtureApp(fixtureRoot, workdir);

    // `lint: false` keeps `LUNORA_ADVISORIES` empty in the captured fixture so the
    // snapshot stays decoupled from advisor behaviour — matches the snapshot test.
    const result = runCodegen({ lint: false, projectRoot: workdir });
    const expectedDirectory = join(fixtureRoot, goldenDirectory);

    mkdirSync(expectedDirectory, { recursive: true });

    for (const [file, key] of GOLDEN_OUTPUTS) {
        writeFileSync(join(expectedDirectory, file), result.generated[key], "utf8");
    }

    // eslint-disable-next-line no-console
    console.log("Wrote expected fixtures to", expectedDirectory);
}
