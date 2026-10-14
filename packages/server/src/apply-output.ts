import { LunoraError } from "@lunora/errors";
import type { Validator } from "@lunora/values";
import { ValidationError } from "@lunora/values";

/**
 * Parse the handler result through `.output()`. A mismatch here is a server
 * contract bug, not a client error, so re-tag it as a 500. Every
 * result-parsing site (RPC, REST, any future transport) must route through
 * this helper rather than calling `output.parse` directly, so the re-tagging
 * (and the wire-level redaction internal codes get) applies uniformly.
 */
const applyOutput = (output: Validator, result: unknown): unknown => {
    try {
        // `rejectUnknownKeys` — the asymmetry that makes this safe. Stripping is
        // right on the way IN (it is what stops an over-posted field reaching a
        // handler) and wrong on the way OUT, where the same behaviour deletes a
        // field the server meant to send. A column present in the row and absent
        // from the validator used to vanish from every response with no error
        // anywhere; it is now a loud 500 naming the key. Narrowing on purpose
        // stays available, and becomes visible, via `.strip()`.
        return output.parse(result, { rejectUnknownKeys: true });
    } catch (error: unknown) {
        if (error instanceof ValidationError) {
            throw new LunoraError("INTERNAL_SERVER_ERROR", `Response did not match the declared output schema: ${error.message}`);
        }

        throw error;
    }
};

export default applyOutput;
