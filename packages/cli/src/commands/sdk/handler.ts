import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { OpenRpcDocument } from "@lunora/codegen";
import { emitPythonSdk, renderPythonModels } from "@lunora/codegen";
import { LunoraError } from "@lunora/errors";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { SdkOptions } from "./index";
import { SDK_LANGUAGE_HELP, SDK_LANGUAGES } from "./index";

/** Where `lunora codegen --api-spec openrpc` writes the document by default. */
const DEFAULT_SPEC_PATH = join("lunora", "_generated", "openrpc.json");

/**
 * Read and shallow-validate the OpenRPC document. A missing file is the common
 * case — the project has not run codegen with `--api-spec openrpc` — so it gets
 * a directive error rather than a bare ENOENT.
 */
const readOpenRpcDocument = (specPath: string): OpenRpcDocument => {
    if (!existsSync(specPath)) {
        throw new LunoraError(
            "NOT_FOUND",
            `no OpenRPC document at ${specPath} — run \`lunora codegen --api-spec openrpc\` (or \`--api-spec both\`) first, or pass --spec`,
        );
    }

    const parsed = JSON.parse(readFileSync(specPath, "utf8")) as OpenRpcDocument;

    if (!Array.isArray(parsed.methods)) {
        throw new LunoraError("BAD_REQUEST", `${specPath} is not an OpenRPC document (no \`methods\` array)`);
    }

    return parsed;
};

const execute: CommandHandler<SdkOptions> = defineHandler<SdkOptions>(async ({ argument, cwd, logger, options }) => {
    const subcommand = argument[0] ?? "generate";

    if (subcommand !== "generate") {
        throw new LunoraError("BAD_REQUEST", `unknown subcommand "${subcommand}" — the only one is \`lunora sdk generate\``);
    }

    const language = options.lang ?? "python";

    if (!(SDK_LANGUAGES as ReadonlyArray<string>).includes(language)) {
        throw new LunoraError("BAD_REQUEST", `unsupported --lang "${language}" — expected one of: ${SDK_LANGUAGE_HELP}`);
    }

    const specPath = resolve(cwd, options.spec ?? DEFAULT_SPEC_PATH);
    const outputDirectory = resolve(cwd, options.out ?? join("sdk", language));

    const document = readOpenRpcDocument(specPath);

    if (document.methods.length === 0) {
        logger.warn(`${specPath} declares no methods — nothing to generate.`);

        return { code: 0 };
    }

    const models = await renderPythonModels(document);
    const files = emitPythonSdk({ document, models });

    for (const [relativePath, contents] of Object.entries(files)) {
        const target = join(outputDirectory, relativePath);

        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, contents, "utf8");
    }

    // The count of methods whose `result` is still the untyped placeholder —
    // every function without a declared `.output()`. Those generate `-> Any`,
    // so surface it rather than letting an untyped SDK look complete.
    const untypedResults = document.methods.filter((method) => method.result?.schema?.type === undefined).length;

    logger.success(`Generated ${language} SDK for ${String(document.methods.length)} function(s) → ${outputDirectory}`);

    if (untypedResults > 0) {
        logger.warn(
            `${String(untypedResults)} of ${String(document.methods.length)} function(s) return \`Any\` — declare \`.output()\` on them for typed results.`,
        );
    }

    return { code: 0 };
});

export { execute };
