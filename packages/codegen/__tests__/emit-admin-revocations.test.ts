import { describe, expect, it } from "vitest";

import { emitAdminRevocations } from "../src/emit";

describe(emitAdminRevocations, () => {
    it("forwards the class from the scoped package, for every app", () => {
        expect.assertions(2);

        const emitted = emitAdminRevocations(false);

        expect(emitted).toContain('export { AdminRevocationDO } from "@lunora/do";');
        expect(emitted).toContain("ADMIN_REVOCATIONS");
    });

    it("forwards it from the umbrella package when the project uses it", () => {
        expect.assertions(1);

        expect(emitAdminRevocations(true)).toMatch(/export \{ AdminRevocationDO \} from "lunorash[^"]*";/u);
    });
});
