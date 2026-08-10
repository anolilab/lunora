/**
 * The model layer: JSON Schema → data classes, via `quicktype-core`.
 *
 * This is the part that does NOT get re-written per language. quicktype already
 * knows how each of its backends spells a field, maps a wire `camelCase` key
 * onto the local convention, renders an `anyOf`-of-consts as an enum, and makes
 * an absent-from-`required` property optional. A target contributes a backend
 * name and renderer options; everything else is shared.
 */

import type { OpenRpcDocument } from "./spec";
import { modelSources } from "./spec";
import type { SdkTarget } from "./target";

/**
 * Render the model source for `document` in `target`'s language.
 *
 * Sources are added in the sorted order {@link modelSources} returns, because
 * quicktype renders in add-order — without it, two runs over the same schema
 * could emit the same types in a different sequence and churn the diff.
 */
const renderModels = async (document: OpenRpcDocument, target: SdkTarget): Promise<string> => {
    // A target with no model backend emits no models, so there is nothing to
    // render — and skipping it also keeps the multi-megabyte quicktype off the
    // path entirely for those languages.
    if (target.quicktype === undefined) {
        return "";
    }

    const sources = modelSources(document);

    if (sources.length === 0) {
        return "";
    }

    // Loaded on demand, not at module scope. `@lunora/codegen`'s barrel is
    // imported by the Vite plugin and every CLI command, and quicktype is a
    // multi-megabyte dependency that exists solely for `lunora sdk generate` —
    // a command most projects never run. A static import would put it on the
    // dev-server boot path for everyone.
    const { InputData, JSONSchemaInput, JSONSchemaStore, quicktype } = await import("quicktype-core");

    // NOT `FetchingJSONSchemaStore`, which resolves `$ref` over the NETWORK
    // during codegen. `openrpc.ts` never emits a ref, so the capability buys
    // nothing — and `--spec` accepts a hand-written document, so it would let one
    // point codegen at an arbitrary URL. `JSONSchemaStore` is abstract; resolving
    // to `undefined` fails the ref closed instead.
    class NoRemoteRefStore extends JSONSchemaStore {
        // eslint-disable-next-line class-methods-use-this -- the abstract base declares an instance method.
        public fetch(): Promise<undefined> {
            return Promise.resolve(undefined);
        }
    }

    const schemaInput = new JSONSchemaInput(new NoRemoteRefStore());

    for (const source of sources) {
        // eslint-disable-next-line no-await-in-loop -- addSource mutates shared input state; concurrent adds interleave type names.
        await schemaInput.addSource({ name: source.name, schema: JSON.stringify(source.schema) });
    }

    const inputData = new InputData();

    inputData.addInput(schemaInput);

    const { lines } = await quicktype({
        inputData,
        lang: target.quicktype.lang,
        rendererOptions: target.quicktype.rendererOptions ?? {},
    });

    return lines.join("\n");
};

export default renderModels;
