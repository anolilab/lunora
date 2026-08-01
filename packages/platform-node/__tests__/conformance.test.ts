import { defineHostContractSuite } from "@lunora/platform/conformance";
import { describe, expect, it } from "vitest";

import { createNodeConformanceHost } from "../src/conformance";

describe("@lunora/platform-node/conformance", () => {
    defineHostContractSuite("node", createNodeConformanceHost, { describe, expect, it });
});
