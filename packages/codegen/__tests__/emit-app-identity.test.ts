import { describe, expect, it } from "vitest";

import { emitApp } from "../src/emit-app";

/** Minimal `EmitAppOptions` with every capability off; the identity tests flip only the contract. */
const baseOptions = {
    hasAccess: false,
    hasAi: false,
    hasAnalytics: false,
    hasAuth: false,
    hasBrowser: false,
    hasFramework: false,
    hasGlobal: false,
    hasHyperdrive: false,
    hasHyperdriveGlobal: false,
    hasImages: false,
    hasKv: false,
    hasNotify: false,
    hasPayments: false,
    hasQueue: false,
    hasR2sql: false,
    hasScheduler: false,
    hasStorage: false,
    hasVectors: false,
    hasWorkflow: false,
    hasX402: false,
    useUmbrella: false,
    wantsOpenApi: false,
    wantsOpenRpc: false,
};

describe("emitApp — defineIdentity trust-boundary wiring", () => {
    it("emits no identity import or option when no contract is declared", () => {
        expect.assertions(2);

        const output = emitApp({ ...baseOptions });

        expect(output).not.toContain("../identity.js");
        expect(output).not.toContain("identity:");
    });

    it("keeps app.ts byte-identical to the no-contract output when the contract is absent", () => {
        expect.assertions(1);

        // `identity: undefined` must produce exactly the same bytes as omitting it —
        // every new fragment is gated on the contract's presence.
        expect(emitApp({ ...baseOptions, identity: undefined })).toBe(emitApp({ ...baseOptions }));
    });

    it("imports the contract as a value and wires options.identity when a contract is declared", () => {
        expect.assertions(3);

        const output = emitApp({ ...baseOptions, identity: { exportName: "identity" } });

        // Imported as a VALUE (not `import type`) so it can actually validate at runtime.
        expect(output).toContain(`import * as lunoraIdentityContract from "../identity.js";`);
        expect(output).not.toContain(`import type * as lunoraIdentityContract`);
        // Wired onto the worker options so the runtime contract gate runs.
        expect(output).toContain("identity: lunoraIdentityContract.identity,");
    });

    it("references the declared export name verbatim", () => {
        expect.assertions(1);

        const output = emitApp({ ...baseOptions, identity: { exportName: "appIdentity" } });

        expect(output).toContain("identity: lunoraIdentityContract.appIdentity,");
    });
});
