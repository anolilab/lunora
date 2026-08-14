/**
 * SDK generation: an OpenRPC document plus a language target in, a directory of
 * generated source out.
 *
 * The split is the point. `spec.ts` parses once, language-neutrally; `models.ts`
 * delegates the data classes to quicktype (or `jvm-models.ts` emits them, for the
 * two backends quicktype cannot map back onto the wire); a target under `targets/`
 * contributes only naming and templates. Adding a language is a new file in
 * `targets/` plus a hand-written transport under `sdks/<lang>/` — never a fork of
 * the parsing.
 *
 * This module emits SOURCE ONLY. The transport that source imports is copied into
 * the same output directory by the CLI (`commands/sdk/vendor.ts`), which is where
 * the filesystem and the network live; a target declares only what to copy and
 * where. See {@link file://./target.ts} for why it is copied rather than
 * installed from a registry.
 */

import renderModels from "./models";
import type { OpenRpcDocument } from "./spec";
import { assertGeneratable, parseSpec, undeclaredModels, unrepresentableFunctions, withDeclaredModels } from "./spec";
import type { SdkTarget } from "./target";
import { dartTarget } from "./targets/dart";
import goTarget from "./targets/go";
import { javaTarget } from "./targets/java";
import { kotlinTarget } from "./targets/kotlin";
import { pythonTarget } from "./targets/python";
import { rubyTarget } from "./targets/ruby";
import { rustTarget } from "./targets/rust";
import { swiftTarget } from "./targets/swift";

/** Every language `lunora sdk generate --lang` accepts, keyed by id. */
const SDK_TARGETS: Readonly<Record<string, SdkTarget>> = {
    dart: dartTarget,
    go: goTarget,
    java: javaTarget,
    kotlin: kotlinTarget,
    python: pythonTarget,
    ruby: rubyTarget,
    rust: rustTarget,
    swift: swiftTarget,
};

/** The accepted `--lang` values, sorted — for help text and error messages. */
const SDK_LANGUAGES: ReadonlyArray<string> = Object.keys(SDK_TARGETS).toSorted((a, b) => a.localeCompare(b));

/** The files a generation run writes, keyed by path relative to the output directory. */
type SdkFiles = Record<string, string>;

/** What a generation run produced, plus what it had to weaken and why. */
interface SdkResult {
    files: SdkFiles;

    /**
     * Model names predicted from the schema that the chosen backend did not
     * declare, so their call sites fell back to an untyped return. Surfaced
     * rather than swallowed — silently weaker types are how an SDK looks
     * finished while returning `Any` everywhere.
     */
    undeclared: ReadonlyArray<string>;

    /**
     * Functions whose args or result carry a `v.bigint()` or `v.bytes()`. No
     * typed model can represent those — the wire needs a tagged value that no
     * generated field produces — so their parameters stay untyped and the
     * caller passes wire values directly.
     */
    unrepresentable: ReadonlyArray<string>;
}

/**
 * Generate the SDK for `document` in `target`'s language.
 *
 * Async only because the model layer is: quicktype's renderer is promise-based.
 * The surface itself is pure, so a target's `render` stays synchronous and
 * unit-testable without touching quicktype.
 *
 * Models are rendered BEFORE the surface because the surface's model references
 * depend on what the backend actually declared — see {@link withDeclaredModels}.
 */
const generateSdk = async (document: OpenRpcDocument, target: SdkTarget): Promise<SdkResult> => {
    const parsed = parseSpec(document);

    // Fail before rendering anything: an ambiguous or invalid name produces
    // source that does not compile, and the cause is far clearer here.
    assertGeneratable(parsed);

    // A target that emits its own models does so as FILES, because Java takes one
    // per class. Either way the reconciliation below reads a single string: a name
    // the models do not declare must not be referenced by the surface.
    const modelFiles = target.renderModels?.(document);
    const models = modelFiles === undefined ? await renderModels(document, target) : Object.values(modelFiles).join("\n");
    const namespaces = withDeclaredModels(parsed, models);

    return {
        files: { ...modelFiles, ...target.render({ models, namespaces }) },
        undeclared: undeclaredModels(parsed, models),
        unrepresentable: unrepresentableFunctions(document),
    };
};

export { generateSdk, SDK_LANGUAGES, SDK_TARGETS };
export type { SdkFiles, SdkResult };
export type { OpenRpcDocument, OpenRpcMethod, RuntimeVerb, SdkMethod, SdkNamespace } from "./spec";
export { isTypedSchema } from "./spec";
export type { SdkRenderInput, SdkTarget, SdkVendorEntry } from "./target";
