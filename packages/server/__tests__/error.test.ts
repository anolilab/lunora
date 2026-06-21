import { describe, expect, it } from "vitest";

import { LunoraError } from "../src/error";

/**
 * `LunoraError` is the canonical thrown type: the runtime's structural error
 * mapper keys off `name === "LunoraError"` plus the numeric `status`, so the
 * code→status table is a wire contract. These lock the mapping (a regression
 * would mis-status every handler/middleware throw) and the message defaulting.
 */
describe("lunoraError", () => {
    it("maps each code to its documented HTTP status", () => {
        expect.assertions(13);

        expect(new LunoraError("BAD_REQUEST").status).toBe(400);
        expect(new LunoraError("UNAUTHORIZED").status).toBe(401);
        expect(new LunoraError("FORBIDDEN").status).toBe(403);
        expect(new LunoraError("NOT_FOUND").status).toBe(404);
        expect(new LunoraError("CONFLICT").status).toBe(409);
        expect(new LunoraError("UNPROCESSABLE").status).toBe(422);
        expect(new LunoraError("COUNT_RLS_UNSUPPORTED").status).toBe(422);
        expect(new LunoraError("MASK_UNSUPPORTED").status).toBe(422);
        expect(new LunoraError("RELATION_PREDICATE_UNSUPPORTED").status).toBe(422);
        expect(new LunoraError("TOO_MANY_REQUESTS").status).toBe(429);
        expect(new LunoraError("INTERNAL_SERVER_ERROR").status).toBe(500);
        expect(new LunoraError("NOT_IMPLEMENTED").status).toBe(501);
        expect(new LunoraError("BAD_REQUEST", "custom").message).toBe("custom");
    });

    it("carries name + code and defaults the message to the code", () => {
        expect.assertions(3);

        const error = new LunoraError("FORBIDDEN");

        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe("LunoraError");
        // No message supplied → the code is the message.
        expect(error.message).toBe("FORBIDDEN");
    });
});
