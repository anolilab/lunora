import { describe, expect, it } from "vitest";

import { createReferenceHost, defineHostContractSuite } from "../src/conformance";

describe("@lunora/platform/conformance", () => {
    defineHostContractSuite("reference", createReferenceHost, { describe, expect, it });
});
