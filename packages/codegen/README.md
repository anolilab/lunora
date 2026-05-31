# @cirrus/codegen

Code generator for the Cirrus framework. Parses a project's `cirrus/schema.ts` plus every function file under `cirrus/`, then emits `cirrus/_generated/{api,server,dataModel}.ts` so the rest of the app gets fully typed access to its own backend.

Most users never invoke this package directly — the `cirrus codegen` CLI command and the `@cirrus/vite` plugin both call it on your behalf. The direct API stays public for monorepo build scripts and custom generator pipelines.

## Install

```bash
pnpm add -D @cirrus/codegen
```

Dependency: `ts-morph` (used to walk the TypeScript AST without a full type-checker round-trip).

## Usage

```ts
import { runCodegen } from "@cirrus/codegen";

const result = runCodegen({ projectRoot: process.cwd() });

console.log(`wrote dataModel.ts, api.ts, server.ts -> ${result.outputDirectory}`);
```

Or via the CLI (preferred for app code):

```bash
cirrus codegen
```

### Custom build scripts

The lower-level discovery and emit helpers are exported individually so monorepos can compose their own pipelines (e.g. emit into a custom directory, fan out to multiple apps, snapshot-diff in CI):

```ts
import { discoverSchema, discoverFunctions, emitApi, emitDataModel, emitServer } from "@cirrus/codegen";
import { Project } from "ts-morph";

const project = new Project({ tsConfigFilePath: "tsconfig.json" });
const schema = discoverSchema(project, "cirrus/schema.ts");
const functions = discoverFunctions(project, "cirrus");

writeFileSync("dataModel.ts", emitDataModel(schema));
writeFileSync("api.ts", emitApi(functions));
writeFileSync("server.ts", emitServer());
```

## Validator coverage

The parser ([`parse-validator.ts`](./src/parse-validator.ts)) understands every kind the [`v` namespace](../values) exposes:

- Primitives: `v.string()`, `v.number()`, `v.boolean()`, `v.bigint()`, `v.null()`, `v.bytes()`, `v.any()`
- `v.id("tableName")` — generates a branded `Id<"tableName">`
- `v.literal("admin")` — captures the source text so the emitted TS type matches the literal exactly
- `v.array(inner)`, `v.optional(inner)`, `v.union(a, b, c)`
- `v.object({ ... })` — recursively walks the shape
- `v.record(keyValidator, valueValidator)`

Unknown validator kinds throw `Unsupported validator kind: <name>` at parse time. This is intentional — silently emitting `unknown` would mask codegen bugs. If you add a new validator kind in `@cirrus/values`, add a matching branch here.

## API

| Export                   | Description                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `runCodegen(options)`    | Top-level entry. Discovers + emits. Returns the output directory.                      |
| `discoverSchema(...)`    | Parse `schema.ts` into a `SchemaIR`.                                                   |
| `discoverFunctions(...)` | Walk a directory and parse every `query`/`mutation`/`action` call into a `FunctionIR`. |
| `emitApi(functions)`     | Render the typed `api.ts`.                                                             |
| `emitDataModel(schema)`  | Render the typed `dataModel.ts`.                                                       |
| `emitServer()`           | Render the per-project `server.ts` re-export.                                          |
| `GENERATED_HEADER`       | Header banner prepended to every emitted file.                                         |

Types: `CodegenOptions`, `CodegenResult`, `SchemaIR`, `TableIR`, `IndexIR`, `FunctionIR`, `ValidatorIR`, `ProjectIR`.

## Behavior notes

- `writeIfChanged` avoids touching files whose contents haven't changed, so Vite/HMR won't reload on no-op runs.
- When a `tsconfig.json` is found by walking up from the cirrus directory, it is loaded so cross-file type resolution and path aliases work. Otherwise an isolated `ts-morph` project is used.

## Docs

- Repo root: [README.md](../../README.md)
- Schema concepts: [apps/docs/content/docs/concepts/schema.mdx](../../apps/docs/content/docs/concepts/schema.mdx)

## License

MIT — see [LICENSE.md](../../LICENSE.md)
