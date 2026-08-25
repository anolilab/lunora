import { defineHostContractSuite } from "@lunora/platform/conformance";
import { describe, expect, it } from "vitest";

import { createRivetConformanceHost } from "../src/conformance";

describe("@lunora/platform-rivet/conformance", () => {
    defineHostContractSuite("rivet", createRivetConformanceHost, { describe, expect, it });
});
