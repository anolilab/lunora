import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverWorkflowEvents from "../../src/discover/workflow-events";

let workdir: string;

const write = (name: string, source: string): void => {
    writeFileSync(join(workdir, "lunora", name), source, "utf8");
};

const discover = () => discoverWorkflowEvents(new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false }), join(workdir, "lunora"));

const HEADER = `import { defineWorkflowEvent } from "@lunora/workflow";\nimport { v } from "@lunora/values";\n\n`;

describe("discoverWorkflowEvents", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-workflow-events-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reads every exported definition's literal type, untrimmed and sorted by type, from any lunora file", () => {
        expect.assertions(1);

        write(
            "events.ts",
            `${HEADER}export const orderApproved = defineWorkflowEvent("order-approved", v.object({ approvedBy: v.string() }));\nexport const spaced = defineWorkflowEvent(" padded ", v.null());\n`,
        );
        write(
            "workflows.ts",
            `import { defineWorkflowEvent as event } from "@lunora/workflow";\nimport { v } from "@lunora/values";\n\nexport const cancelled = event("cancelled", v.null()) satisfies object;\n`,
        );

        expect(discover()).toStrictEqual([
            { exportName: "spaced", filePath: "events", type: " padded " },
            { exportName: "cancelled", filePath: "workflows", type: "cancelled" },
            { exportName: "orderApproved", filePath: "events", type: "order-approved" },
        ]);
    });

    it("finds nothing in an app without events", () => {
        expect.assertions(1);

        write("plain.ts", `export const answer = 42;\n`);

        expect(discover()).toStrictEqual([]);
    });

    it("skips an unexported definition and a same-named function from elsewhere", () => {
        expect.assertions(1);

        write("local.ts", `${HEADER}const hidden = defineWorkflowEvent("hidden", v.null());\nexport const used = hidden;\n`);
        write("other.ts", `import { defineWorkflowEvent } from "./not-workflow";\n\nexport const fake = defineWorkflowEvent("fake");\n`);

        expect(discover()).toStrictEqual([]);
    });

    it("rejects a type that is not a string literal", () => {
        expect.assertions(1);

        write("events.ts", `${HEADER}const TYPE = "order-approved";\nexport const orderApproved = defineWorkflowEvent(TYPE, v.null());\n`);

        expect(discover).toThrow(/workflow event "orderApproved": defineWorkflowEvent's `type` must be a string literal/u);
    });

    it("rejects two exports declaring the same type", () => {
        expect.assertions(1);

        write("events.ts", `${HEADER}export const a = defineWorkflowEvent("dup", v.null());\n`);
        write("more.ts", `${HEADER}export const b = defineWorkflowEvent("dup", v.null());\n`);

        expect(discover).toThrow(/workflow event type "dup" is declared by both lunora\/events\.ts \(a\) and lunora\/more\.ts \(b\)/u);
    });
});
