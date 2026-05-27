import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCodegen } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "simple");

const workdir = mkdtempSync(join(tmpdir(), "cirrus-capture-"));

cpSync(join(fixtureRoot, "cirrus"), join(workdir, "cirrus"), { recursive: true });

const result = runCodegen({ projectRoot: workdir });
const expectedDirectory = join(fixtureRoot, "expected", "_generated");

mkdirSync(expectedDirectory, { recursive: true });
writeFileSync(join(expectedDirectory, "api.ts"), result.generated.api, "utf8");
writeFileSync(join(expectedDirectory, "server.ts"), result.generated.server, "utf8");
writeFileSync(join(expectedDirectory, "dataModel.ts"), result.generated.dataModel, "utf8");

// eslint-disable-next-line no-console
console.log("Wrote expected fixtures to", expectedDirectory);
