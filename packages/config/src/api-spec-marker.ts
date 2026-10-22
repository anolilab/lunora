import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The API specs codegen can emit; `"openapi"` is codegen's own default. */
type MarkedApiSpec = "both" | "none" | "openapi" | "openrpc";

const MARKER_PATH = join(".lunora", "api-spec.json");

const SPECS: ReadonlyArray<MarkedApiSpec> = ["both", "none", "openapi", "openrpc"];

/**
 * Record which API spec the bundler plugin's codegen emitted. The CLI's deploy runs the plugin's build
 * before its own codegen, and that codegen must emit the same spec, or it deletes the files the plugin
 * wrote. The plugin is the only place its option is read, so it leaves the answer here.
 */
const writeApiSpecMarker = (projectRoot: string, apiSpec: MarkedApiSpec | undefined): void => {
    const path = join(projectRoot, MARKER_PATH);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ apiSpec: apiSpec ?? "openapi" })}\n`, "utf8");
};

/** Forget a recorded spec, so the next read sees only what a new client build writes. */
const clearApiSpecMarker = (projectRoot: string): void => {
    rmSync(join(projectRoot, MARKER_PATH), { force: true });
};

/** The spec the last plugin codegen recorded, or `undefined` when there is no readable record. */
const readApiSpecMarker = (projectRoot: string): MarkedApiSpec | undefined => {
    try {
        const { apiSpec } = JSON.parse(readFileSync(join(projectRoot, MARKER_PATH), "utf8")) as { apiSpec?: unknown };

        return SPECS.find((spec) => spec === apiSpec);
    } catch {
        return undefined;
    }
};

export type { MarkedApiSpec };
export { clearApiSpecMarker, readApiSpecMarker, writeApiSpecMarker };
