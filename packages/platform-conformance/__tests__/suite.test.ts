import { describe, expect, it } from "vitest";

import { createReferenceHost, defineHostContractSuite } from "../src";

describe("@lunora/platform-conformance", () => {
    defineHostContractSuite("reference", createReferenceHost, { describe, expect, it });
});
