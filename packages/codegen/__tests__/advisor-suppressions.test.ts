import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Finding } from "@lunora/advisor";
import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applySuppressions } from "../src/advisor-suppressions";
import { errorAdvisoryNames } from "../src/blocking";
import { runCodegen } from "../src/index";

const SECRET_RULE = "allow_unauthenticated_shard_access_enabled";

/** A schema with an unindexed foreign key, so the schema lints run and the server file can trip its own rule. */
const UNINDEXED_SCHEMA = `
import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    users: defineTable({ name: v.string() }),
    posts: defineTable({ authorId: v.id("users"), title: v.string() }).relations((r) => ({
        author: r.one("users", { field: "authorId" }),
    })),
});
`;

/** A `.extend()` that turns on unauthenticated shard access: fires `allow_unauthenticated_shard_access_enabled` on its call line. */
const OPEN_APP = `import { defineApp } from "@lunora/runtime";
export const app = defineApp().extend(() => ({ allowUnauthenticatedShardAccess: true })).build();
`;

const finding = (name: string, file: string, line: number): Finding => {
    return {
        cacheKey: `${name}:${file}:${line.toString()}`,
        categories: ["SECURITY"],
        description: "",
        detail: "",
        facing: "INTERNAL",
        level: "ERROR",
        metadata: { file, line },
        name,
        remediation: "",
        title: "",
    };
};

describe("advisor suppressions through runCodegen", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-suppress-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "lunora", "schema.ts"), UNINDEXED_SCHEMA, "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const advisoriesFor = (server: string, wrangler?: { keys: string[]; text: string }) => {
        writeFileSync(join(workdir, "lunora", "server.ts"), server, "utf8");

        if (wrangler === undefined) {
            return runCodegen({ projectRoot: workdir, wranglerQueueProducers: [] }).advisories;
        }

        writeFileSync(join(workdir, "wrangler.jsonc"), wrangler.text, "utf8");

        // The CLI reads these from wrangler.jsonc; the test supplies the same evidence directly.
        const wranglerVariables = wrangler.keys.map((key) => {
            return {
                file: "wrangler.jsonc",
                key,
                kind: "secret_named_var",
                line: wrangler.text.split("\n").findIndex((text) => text.includes(`"${key}"`)) + 1,
                preview: "sk_live…",
            };
        });

        return runCodegen({ projectRoot: workdir, wranglerQueueProducers: [], wranglerVariables }).advisories;
    };

    const named = (advisories: ReadonlyArray<Finding>, name: string) => advisories.filter((advisory) => advisory.name === name);

    it("suppresses a rule at a single-line site and keeps the finding with its reason", () => {
        expect.assertions(3);

        const advisories = advisoriesFor(
            `import { defineApp } from "@lunora/runtime";
// lunora-advisor-exempt ${SECRET_RULE} -- single-tenant demo, no shared rows
export const app = defineApp().extend(() => ({ allowUnauthenticatedShardAccess: true })).build();
`,
        );
        const [hit] = named(advisories, SECRET_RULE);

        expect(hit?.suppressed).toStrictEqual({ file: "lunora/server.ts", line: 2, reason: "single-tenant demo, no shared rows" });
        expect(errorAdvisoryNames(advisories)).not.toContain(SECRET_RULE);
        expect(named(advisories, "advisor_suppression_unused")).toHaveLength(0);
    });

    it("covers a multi-line statement whose finding reports a line inside it", () => {
        expect.assertions(2);

        const advisories = advisoriesFor(
            `import { defineApp } from "@lunora/runtime";
// lunora-advisor-exempt ${SECRET_RULE} -- single-tenant demo
export const app = defineApp()
    .extend(() => ({
        allowUnauthenticatedShardAccess: true,
    }))
    .build();
`,
        );
        const [hit] = named(advisories, SECRET_RULE);

        expect(hit?.suppressed?.reason).toBe("single-tenant demo");
        expect(hit?.metadata["line"]).toBeGreaterThan(2);
    });

    it("does not suppress a different rule on the same line", () => {
        expect.assertions(2);

        const advisories = advisoriesFor(
            `import { defineApp } from "@lunora/runtime";
// lunora-advisor-exempt unindexed_foreign_key -- wrong rule for this site
export const app = defineApp().extend(() => ({ allowUnauthenticatedShardAccess: true })).build();
`,
        );

        expect(named(advisories, SECRET_RULE)[0]?.suppressed).toBeUndefined();
        expect(named(advisories, "advisor_suppression_unused").map((entry) => entry.metadata["rule"])).toContain("unindexed_foreign_key");
    });

    it("does not suppress one statement below the directive", () => {
        expect.assertions(2);

        const advisories = advisoriesFor(
            `import { defineApp } from "@lunora/runtime";
// lunora-advisor-exempt ${SECRET_RULE} -- meant for the statement below
const unrelated = 1;
export const app = defineApp().extend(() => ({ allowUnauthenticatedShardAccess: true })).build();
`,
        );

        expect(named(advisories, SECRET_RULE)[0]?.suppressed).toBeUndefined();
        expect(named(advisories, "advisor_suppression_unused")).toHaveLength(1);
    });

    it("reports a directive with no reason as invalid and suppresses nothing", () => {
        expect.assertions(3);

        const advisories = advisoriesFor(
            `import { defineApp } from "@lunora/runtime";
// lunora-advisor-exempt ${SECRET_RULE}
export const app = defineApp().extend(() => ({ allowUnauthenticatedShardAccess: true })).build();
`,
        );
        const [invalid] = named(advisories, "advisor_suppression_invalid");

        expect(named(advisories, SECRET_RULE)[0]?.suppressed).toBeUndefined();
        expect(invalid?.level).toBe("WARN");
        expect(invalid?.metadata).toMatchObject({ file: "lunora/server.ts", line: 2, rule: SECRET_RULE });
    });

    it("reports an unknown rule id as invalid", () => {
        expect.assertions(1);

        const advisories = advisoriesFor(
            `import { defineApp } from "@lunora/runtime";
// lunora-advisor-exempt no_such_rule -- typo
export const app = defineApp().extend(() => ({ allowUnauthenticatedShardAccess: true })).build();
`,
        );

        expect(named(advisories, "advisor_suppression_invalid").map((entry) => entry.metadata["rule"])).toContain("no_such_rule");
    });

    it("reports a runtime lint id as invalid, since runtime lints have no source site", () => {
        expect.assertions(1);

        const advisories = advisoriesFor(
            `import { defineApp } from "@lunora/runtime";
// lunora-advisor-exempt hot_shard -- runtime signal
export const app = defineApp().extend(() => ({ allowUnauthenticatedShardAccess: true })).build();
`,
        );

        expect(named(advisories, "advisor_suppression_invalid").map((entry) => entry.metadata["rule"])).toContain("hot_shard");
    });

    it("keeps the whole-procedure directive as an exemption and suppresses nothing", () => {
        expect.assertions(3);

        writeFileSync(
            join(workdir, "lunora", "legacy.ts"),
            `import { mutation } from "@lunora/server";
// lunora-advisor-exempt -- legacy endpoint, removed in Q3
export const legacy = mutation({ args: {}, handler: async () => { throw new Error("boom"); } });
`,
            "utf8",
        );

        const result = runCodegen({ projectRoot: workdir, wranglerQueueProducers: [] });
        const row = result.advisorContext?.procedureProtections?.find((entry) => entry.exportName === "legacy");

        expect(row?.exempt).toBe(true);
        expect(row?.exemptReason).toBe("legacy endpoint, removed in Q3");
        expect(result.advisories.filter((advisory) => advisory.name.startsWith("advisor_suppression"))).toHaveLength(0);
    });

    it("does not treat a rule-scoped directive as a whole-procedure exemption", () => {
        expect.assertions(2);

        writeFileSync(
            join(workdir, "lunora", "scoped.ts"),
            `import { mutation } from "@lunora/server";
// lunora-advisor-exempt procedure_without_structured_event -- scoped, not a procedure exemption
export const scoped = mutation({ args: {}, handler: async () => { throw new Error("boom"); } });
`,
            "utf8",
        );

        const result = runCodegen({ projectRoot: workdir, wranglerQueueProducers: [] });
        const row = result.advisorContext?.procedureProtections?.find((entry) => entry.exportName === "scoped");

        expect(row?.exempt).toBe(false);
        expect(result.advisories.filter((advisory) => advisory.name === "advisor_suppression_invalid")).toHaveLength(0);
    });

    it("suppresses a wrangler.jsonc variable only for the key below the directive", () => {
        expect.assertions(3);

        const advisories = advisoriesFor(OPEN_APP, {
            keys: ["STRIPE_SECRET", "OTHER_SECRET"],
            text: `{
  "name": "app",
  "vars": {
    // lunora-advisor-exempt plaintext_secret_in_wrangler_vars -- rotated and read by the test harness only
    "STRIPE_SECRET": "sk_live_0000000000000000",
    "OTHER_SECRET": "sk_live_1111111111111111"
  }
}
`,
        });
        const secrets = named(advisories, "plaintext_secret_in_wrangler_vars");
        const stripe = secrets.find((entry) => entry.metadata["key"] === "STRIPE_SECRET");
        const other = secrets.find((entry) => entry.metadata["key"] === "OTHER_SECRET");

        expect(stripe?.suppressed?.file).toBe("wrangler.jsonc");
        expect(other?.suppressed).toBeUndefined();
        expect(named(advisories, "advisor_suppression_unused")).toHaveLength(0);
    });
    it("attaches a wrangler directive only to the first key of a line holding two", () => {
        expect.assertions(2);

        const advisories = advisoriesFor(OPEN_APP, {
            keys: ["STRIPE_SECRET", "OTHER_SECRET"],
            text: `{
  "vars": {
    // lunora-advisor-exempt plaintext_secret_in_wrangler_vars -- rotated and read by the test harness only
    "STRIPE_SECRET": "sk_live_0000000000000000", "OTHER_SECRET": "sk_live_1111111111111111"
  }
}
`,
        });
        const secrets = named(advisories, "plaintext_secret_in_wrangler_vars");

        expect(secrets.find((entry) => entry.metadata["key"] === "STRIPE_SECRET")?.suppressed).toBeDefined();
        expect(secrets.find((entry) => entry.metadata["key"] === "OTHER_SECRET")?.suppressed).toBeUndefined();
    });

    it("ignores a wrangler directive inside a block comment", () => {
        expect.assertions(2);

        const advisories = advisoriesFor(OPEN_APP, {
            keys: ["STRIPE_SECRET"],
            text: `{
  "vars": {
    /*
    // lunora-advisor-exempt plaintext_secret_in_wrangler_vars -- commented out */
    "STRIPE_SECRET": "sk_live_0000000000000000"
  }
}
`,
        });

        expect(named(advisories, "plaintext_secret_in_wrangler_vars")[0]?.suppressed).toBeUndefined();
        expect(named(advisories, "advisor_suppression_unused")).toHaveLength(0);
    });

    it("reads directives from wrangler.json when the project has no wrangler.jsonc", () => {
        expect.assertions(1);

        const text = `{
  "vars": {
    // lunora-advisor-exempt plaintext_secret_in_wrangler_vars -- rotated and read by the test harness only
    "STRIPE_SECRET": "sk_live_0000000000000000"
  }
}
`;

        writeFileSync(join(workdir, "lunora", "server.ts"), OPEN_APP, "utf8");
        writeFileSync(join(workdir, "wrangler.json"), text, "utf8");

        const { advisories } = runCodegen({
            projectRoot: workdir,
            wranglerQueueProducers: [],
            wranglerVariables: [{ file: "wrangler.json", key: "STRIPE_SECRET", kind: "secret_named_var", line: 4, preview: "sk_live…" }],
        });

        expect(named(advisories, "plaintext_secret_in_wrangler_vars")[0]?.suppressed?.file).toBe("wrangler.json");
    });

    it("suppresses a finding in a worker entry outside lunora/", () => {
        expect.assertions(2);

        mkdirSync(join(workdir, "src"), { recursive: true });
        writeFileSync(join(workdir, "lunora", "server.ts"), `export const unrelated = 1;\n`, "utf8");
        writeFileSync(
            join(workdir, "src", "worker.ts"),
            `import { defineApp } from "@lunora/runtime";
// lunora-advisor-exempt ${SECRET_RULE} -- single-tenant demo
export const app = defineApp().extend(() => ({ allowUnauthenticatedShardAccess: true })).build();
`,
            "utf8",
        );

        const { advisories } = runCodegen({ projectRoot: workdir, wranglerQueueProducers: [] });

        expect(named(advisories, SECRET_RULE)[0]?.suppressed?.file).toBe("src/worker.ts");
        expect(named(advisories, "advisor_suppression_unused")).toHaveLength(0);
    });

    it("matches a directive for a finding below the severity floor and hides its own warnings below the floor", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora.config.ts"), `export default { advisor: { minSeverity: "error" } };\n`, "utf8");
        writeFileSync(
            join(workdir, "lunora", "posts.ts"),
            `import { mutation } from "@lunora/server";
// lunora-advisor-exempt procedure_without_structured_event -- logged by the caller
export const post = mutation({ args: {}, handler: async () => undefined });
// lunora-advisor-exempt hardcoded_secret
export const other = 1;
`,
            "utf8",
        );

        const advisories = advisoriesFor(OPEN_APP);

        expect(named(advisories, "advisor_suppression_unused")).toHaveLength(0);
        expect(named(advisories, "advisor_suppression_invalid")).toHaveLength(0);
    });

    it("keeps a block-comment directive whose first word is prose as a whole-procedure exemption", () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "lunora", "hook.ts"),
            `import { mutation } from "@lunora/server";
/** lunora-advisor-exempt public webhook -- signed by the provider */
export const hook = mutation({ args: {}, handler: async () => undefined });
`,
            "utf8",
        );

        const result = runCodegen({ projectRoot: workdir, wranglerQueueProducers: [] });

        expect(result.advisorContext?.procedureProtections?.find((entry) => entry.exportName === "hook")?.exempt).toBe(true);
    });
});

describe("applySuppressions on an in-memory project", () => {
    const lunoraDirectory = "/virtual/project/lunora";
    const projectRoot = "/virtual/project";

    const projectWith = (path: string, text: string): Project => {
        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });

        project.createSourceFile(path, text);

        return project;
    };

    it("attaches a directive above the first statement of a file to that statement only", () => {
        expect.assertions(2);

        const project = projectWith(
            `${lunoraDirectory}/shapes.ts`,
            `// lunora-advisor-exempt hardcoded_secret -- fixture value
const first = "a";
const second = "b";
`,
        );
        const [first, second] = applySuppressions(project, projectRoot, lunoraDirectory, [
            finding("hardcoded_secret", "shapes", 2),
            finding("hardcoded_secret", "shapes", 3),
        ]);

        expect(first?.suppressed?.line).toBe(1);
        expect(second?.suppressed).toBeUndefined();
    });

    it("normalises lunora/ prefixes and extensions when matching a finding's file", () => {
        expect.assertions(2);

        const project = projectWith(
            `${lunoraDirectory}/shapes.ts`,
            `const a = 1;
// lunora-advisor-exempt hardcoded_secret -- fixture value
const secret = "xxxxxxxx";
`,
        );
        const [withPrefix, withExtension] = applySuppressions(project, projectRoot, lunoraDirectory, [
            finding("hardcoded_secret", "lunora/shapes.ts", 3),
            finding("hardcoded_secret", "shapes", 3),
        ]);

        expect(withPrefix?.suppressed?.reason).toBe("fixture value");
        expect(withExtension?.suppressed?.reason).toBe("fixture value");
    });

    it("covers a chained call line only, not the whole chain above it", () => {
        expect.assertions(2);

        const project = projectWith(
            `${lunoraDirectory}/chain.ts`,
            `export const app = defineApp()
    // lunora-advisor-exempt hardcoded_secret -- only this link
    .extend(() => ({}))
    .build();
`,
        );
        const [onLink, onBuild] = applySuppressions(project, projectRoot, lunoraDirectory, [
            finding("hardcoded_secret", "chain", 3),
            finding("hardcoded_secret", "chain", 4),
        ]);

        expect(onLink?.suppressed?.line).toBe(2);
        expect(onBuild?.suppressed).toBeUndefined();
    });

    it("ignores a directive-looking line inside a block comment or a template string", () => {
        expect.assertions(3);

        const project = projectWith(
            `${lunoraDirectory}/blocked.ts`,
            `/*
// lunora-advisor-exempt hardcoded_secret -- commented out
*/
const secret = "xxxxxxxx";
const text = \`
// lunora-advisor-exempt hardcoded_secret -- inside a string
\`;
const other = "yyyyyyyy";
`,
        );
        const advisories = applySuppressions(project, projectRoot, lunoraDirectory, [
            finding("hardcoded_secret", "blocked", 4),
            finding("hardcoded_secret", "blocked", 8),
        ]);

        expect(advisories[0]?.suppressed).toBeUndefined();
        expect(advisories[1]?.suppressed).toBeUndefined();
        expect(advisories).toHaveLength(2);
    });

    it("attaches to a code line that opens with a closed block comment", () => {
        expect.assertions(1);

        const project = projectWith(
            `${lunoraDirectory}/inline.ts`,
            `// lunora-advisor-exempt hardcoded_secret -- fixture value
/* note */ const secret = "xxxxxxxx";
const later = "yyyyyyyy";
`,
        );
        const [hit] = applySuppressions(project, projectRoot, lunoraDirectory, [finding("hardcoded_secret", "inline", 2)]);

        expect(hit?.suppressed?.reason).toBe("fixture value");
    });

    it("reports a directive that sits at end of file as unused", () => {
        expect.assertions(1);

        const project = projectWith(`${lunoraDirectory}/tail.ts`, `const a = 1;\n// lunora-advisor-exempt hardcoded_secret -- nothing below\n`);
        const advisories = applySuppressions(project, projectRoot, lunoraDirectory, []);

        expect(advisories.map((entry) => entry.name)).toStrictEqual(["advisor_suppression_unused"]);
    });

    it("leaves an already-suppressed finding alone and does not double count it", () => {
        expect.assertions(1);

        const project = projectWith(`${lunoraDirectory}/once.ts`, `// lunora-advisor-exempt hardcoded_secret -- first\nconst a = "x";\n`);
        const pre: Finding = { ...finding("hardcoded_secret", "once", 2), suppressed: { file: "lunora/once.ts", line: 9, reason: "earlier" } };
        const [kept] = applySuppressions(project, projectRoot, lunoraDirectory, [pre]);

        expect(kept?.suppressed?.reason).toBe("earlier");
    });
});

describe("errorAdvisoryNames", () => {
    it("skips an ERROR that a directive suppressed and keeps an unsuppressed one", () => {
        expect.assertions(1);

        const suppressed: Pick<Finding, "level" | "name" | "suppressed"> = {
            level: "ERROR",
            name: "suppressed_rule",
            suppressed: { file: "lunora/a.ts", line: 1, reason: "accepted" },
        };
        const open: Pick<Finding, "level" | "name" | "suppressed"> = { level: "ERROR", name: "open_rule", suppressed: undefined };

        expect(errorAdvisoryNames([suppressed, open])).toStrictEqual(["open_rule"]);
    });
});
