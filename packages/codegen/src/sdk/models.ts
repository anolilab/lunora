/**
 * The model layer: JSON Schema → data classes, via `quicktype-core`.
 *
 * This is the part that does NOT get re-written per language. quicktype already
 * knows how each of its backends spells a field, maps a wire `camelCase` key
 * onto the local convention, renders an `anyOf`-of-consts as an enum, and makes
 * an absent-from-`required` property optional. A target contributes a backend
 * name and renderer options; everything else is shared.
 */

import { FetchingJSONSchemaStore, InputData, JSONSchemaInput, quicktype } from "quicktype-core";

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
    const sources = modelSources(document);

    if (sources.length === 0) {
        return "";
    }

    const schemaInput = new JSONSchemaInput(new FetchingJSONSchemaStore());

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
