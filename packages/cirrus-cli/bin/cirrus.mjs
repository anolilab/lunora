#!/usr/bin/env node
// Bootstrap shim: execute the TypeScript CLI entry via tsx so users don't
// need a build step. tsx is declared as a dependency of @cirrus/cli.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entry = pathToFileURL(join(here, "..", "src", "cli.ts")).href;

// Register tsx as an ESM loader so we can import the .ts file directly.
const tsxApi = await import("tsx/esm/api");

tsxApi.register();

// eslint-disable-next-line no-unsanitized/method -- entry is constructed from local paths under this script
await import(entry);
