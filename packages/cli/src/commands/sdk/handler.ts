import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { OpenRpcDocument } from "@lunora/codegen";
import { generateSdk, isTypedSchema, SDK_LANGUAGES, SDK_TARGETS } from "@lunora/codegen";
import { LunoraError } from "@lunora/errors";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { sourceGateError } from "../registry/resolve";
import type { SdkOptions } from "./index";
import { STAMP_FILE, vendorTransport, writeStamp } from "./vendor";

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

    let parsed: unknown;

    try {
        parsed = JSON.parse(readFileSync(specPath, "utf8"));
    } catch (error) {
        // A raw SyntaxError escapes the CLI's error rendering; a coded error
        // reaches the user as a diagnostic instead of a stack trace.
        throw new LunoraError("BAD_REQUEST", `${specPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }

    // A `null` root parses fine and then throws on property access, so the
    // object check has to come before reading `methods`.
    if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as OpenRpcDocument).methods)) {
        throw new LunoraError("BAD_REQUEST", `${specPath} is not an OpenRPC document (no \`methods\` array)`);
    }

    return parsed as OpenRpcDocument;
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

    // Checked before anything is generated: a blocked `--source` must not leave
    // half an SDK on disk with no transport under it.
    const blocked = sourceGateError("sdk generate", {
        allowUnsafeSource: options.allowUnsafeSource,
        logger,
        names: [],
        source: options.source,
    });

    if (blocked !== undefined) {
        throw new LunoraError("BAD_REQUEST", blocked);
    }

    const specPath = resolve(cwd, options.spec ?? DEFAULT_SPEC_PATH);
    const outputDirectory = resolve(cwd, options.out ?? join("sdk", language));

    const document = readOpenRpcDocument(specPath);

    if (document.methods.length === 0) {
        // Warn but keep going. Returning here would leave the PREVIOUS
        // generation's files on disk, so removing every RPC function would ship
        // a stale surface that still compiles and still calls functions the
        // deployment no longer has.
        logger.warn(`${specPath} declares no methods — writing an empty SDK.`);
    }

    const { files, undeclared, unrepresentable } = await generateSdk(document, target);

    // The transport FIRST, and before any generated file is written. It is the
    // step that can fail on a ref, a network or a missing language, and failing
    // after the surface is on disk would leave a directory that looks generated
    // and imports a package that is not there.
    mkdirSync(outputDirectory, { recursive: true });

    const vendored = await vendorTransport({
        allowUnsafeSource: options.allowUnsafeSource,
        from: options.from,
        language,
        logger,
        outputDirectory,
        ref: options.ref,
        source: options.source,
        target,
    });

    writeStamp(outputDirectory, language, vendored);

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

    // What was copied and from where, every run. The output is self-contained, so
    // this line is the only place the protocol vintage is stated out loud — and
    // `versionMatched` is the part a reader needs, since the fallback path can
    // pair a new surface with an older transport.
    logger.info(
        `Vendored the ${language} transport (${String(vendored.files.length)} file(s)) from ${vendored.source} @ ${vendored.ref}` +
            `${vendored.versionMatched ? " — version-matched to this CLI" : ""}; see ${STAMP_FILE}.`,
    );

    logger.info(
        target.requires.length > 0
            ? `Install in the consuming project: ${target.requires.join(", ")}.`
            : `Nothing to install — the transport is vendored and needs only the standard library.`,
    );

    if (undeclared.length > 0) {
        // The schema declared a shape, but this language's backend did not turn
        // it into a named type — the call site fell back to an untyped value.
        //
        // Deliberately not worded as a *result* problem: `undeclared` spans
        // argument models too, and pointing the reader at `.output()` for what
        // is actually an input schema sends them to the wrong place.
        logger.warn(
            `${String(undeclared.length)} schema(s) are not expressible as a named ${language} model, so those arguments or returns stay untyped: ${undeclared.join(", ")}`,
        );
    }

    if (unrepresentable.length > 0) {
        logger.warn(
            `${String(unrepresentable.length)} function(s) take or return a \`v.bigint()\`/\`v.bytes()\`, which no generated model can carry — their parameters stay untyped, so pass wire values directly: ${unrepresentable.join(", ")}`,
        );
    }

    if (untypedResults > 0) {
        logger.warn(
            `${String(untypedResults)} of ${String(document.methods.length)} function(s) return an untyped result — declare \`.output()\` on them for typed returns.`,
        );
    }

    return { code: 0 };
});

export { execute };
