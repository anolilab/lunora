import type { Validator } from "@lunora/values";
import { ValidationError } from "@lunora/values";

import { LunoraError } from "./error";

/**
 * Parse the handler result through `.output()`. A mismatch here is a server
 * contract bug, not a client error, so re-tag it as a 500. Every
 * result-parsing site (RPC, REST, any future transport) must route through
 * this helper rather than calling `output.parse` directly, so the re-tagging
 * (and the wire-level redaction internal codes get) applies uniformly.
 */
const applyOutput = (output: Validator, result: unknown): unknown => {
    try {
        return output.parse(result);
    } catch (error: unknown) {
        if (error instanceof ValidationError) {
            throw new LunoraError("INTERNAL_SERVER_ERROR", `Response did not match the declared output schema: ${error.message}`);
        }

        throw error;
    }
};

export default applyOutput;
