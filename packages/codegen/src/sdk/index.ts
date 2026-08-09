/**
 * SDK generation: an OpenRPC document plus a language target in, a directory of
 * generated source out.
 *
 * The split is the point. `spec.ts` parses once, language-neutrally; `models.ts`
 * delegates the data classes to quicktype; a target under `targets/` contributes
 * only naming and templates. Adding a language is a new file in `targets/` plus
 * a hand-written transport under `sdks/<lang>/` — never a fork of the parsing.
 */

import renderModels from "./models";
import type { OpenRpcDocument } from "./spec";
import { parseSpec } from "./spec";
import type { SdkTarget } from "./target";
import pythonTarget from "./targets/python";

/** Every language `lunora sdk generate --lang` accepts, keyed by id. */
const SDK_TARGETS: Readonly<Record<string, SdkTarget>> = { python: pythonTarget };

/** The accepted `--lang` values, sorted — for help text and error messages. */
const SDK_LANGUAGES: ReadonlyArray<string> = Object.keys(SDK_TARGETS).toSorted((a, b) => a.localeCompare(b));

/** The files a generation run writes, keyed by path relative to the output directory. */
type SdkFiles = Record<string, string>;

/**
 * Generate the SDK for `document` in `target`'s language.
 *
 * Async only because the model layer is: quicktype's renderer is promise-based.
 * The surface itself is pure, so a target's `render` stays synchronous and
 * unit-testable without touching quicktype.
 */
const generateSdk = async (document: OpenRpcDocument, target: SdkTarget): Promise<SdkFiles> => {
    const models = await renderModels(document, target);

    return target.render({ models, namespaces: parseSpec(document) });
};

export { generateSdk, SDK_LANGUAGES, SDK_TARGETS };
export type { SdkFiles };
export type { OpenRpcDocument, OpenRpcMethod, RuntimeVerb, SdkMethod, SdkNamespace } from "./spec";
export { allMethods, isTypedSchema, modelSources, parseSpec, referencedModels, verbForKind } from "./spec";
export type { SdkRenderInput, SdkTarget } from "./target";
