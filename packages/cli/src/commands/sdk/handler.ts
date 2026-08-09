import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { OpenRpcDocument } from "@lunora/codegen";
import { generateSdk, isTypedSchema, SDK_LANGUAGES, SDK_TARGETS } from "@lunora/codegen";
import { LunoraError } from "@lunora/errors";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { SdkOptions } from "./index";

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
    const target = SDK_TARGETS[language];

    if (target === undefined) {
        throw new LunoraError("BAD_REQUEST", `unsupported --lang "${language}" — expected one of: ${SDK_LANGUAGES.join(" | ")}`);
    }

    const specPath = resolve(cwd, options.spec ?? DEFAULT_SPEC_PATH);
    const outputDirectory = resolve(cwd, options.out ?? join("sdk", language));

    const document = readOpenRpcDocument(specPath);

    if (document.methods.length === 0) {
        logger.warn(`${specPath} declares no methods — nothing to generate.`);

        return { code: 0 };
    }

    const { files, undeclared } = await generateSdk(document, target);

    for (const [relativePath, contents] of Object.entries(files)) {
        const destination = join(outputDirectory, relativePath);

        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, contents, "utf8");
    }

    // How many functions still return the untyped placeholder — i.e. declare no
    // `.output()`. Uses the same predicate the emitter does, so the warning can
    // never disagree with what was generated.
    const untypedResults = document.methods.filter((method) => !isTypedSchema(method.result?.schema)).length;

    logger.success(`Generated ${language} SDK for ${String(document.methods.length)} function(s) → ${outputDirectory}`);
    logger.info(`The generated code imports the ${target.runtimePackage} runtime — add it to the consuming project.`);

    if (undeclared.length > 0) {
        // The schema declared a shape, but this language's backend did not turn
        // it into a named type — the call site fell back to an untyped return.
        logger.warn(`${String(undeclared.length)} declared result type(s) are not expressible as a named ${language} model, so those calls return untyped: ${undeclared.join(", ")}`);
    }

    if (untypedResults > 0) {
        logger.warn(
            `${String(untypedResults)} of ${String(document.methods.length)} function(s) return an untyped result — declare \`.output()\` on them for typed returns.`,
        );
    }

    return { code: 0 };
});

export { execute };
