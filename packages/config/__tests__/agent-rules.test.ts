import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AGENT_RULES_DIR, AGENT_RULES_HINT_ENV, claimAgentRulesHint, detectAgentRules, LUNORA_SKILL_NAMES } from "../src/agent-rules";

let workdir: string;

/** Write `<workdir>/.agents/skills/<name>/SKILL.md`. */
const installSkill = (name: string): void => {
    const directory = join(workdir, AGENT_RULES_DIR, name);

    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), `# ${name}\n`, "utf8");
};

describe("detectAgentRules", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-agent-rules-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reports not installed for an empty project", () => {
        expect.assertions(3);

        const status = detectAgentRules(workdir);

        expect(status.installed).toBe(false);
        expect(status.present).toHaveLength(0);
        expect(status.missing).toStrictEqual([...LUNORA_SKILL_NAMES]);
    });

    it("counts the router skill as installed even when others are missing", () => {
        expect.assertions(3);

        installSkill("lunora");

        const status = detectAgentRules(workdir);

        expect(status.installed).toBe(true);
        expect(status.present).toStrictEqual(["lunora"]);
        expect(status.missing).not.toContain("lunora");
    });

    it("lists every installed skill as present", () => {
        expect.assertions(2);

        for (const name of LUNORA_SKILL_NAMES) {
            installSkill(name);
        }

        const status = detectAgentRules(workdir);

        expect(status.installed).toBe(true);
        expect(status.present).toStrictEqual([...LUNORA_SKILL_NAMES]);
    });
});

describe("claimAgentRulesHint", () => {
    const previous = process.env[AGENT_RULES_HINT_ENV];

    afterEach(() => {
        if (previous === undefined) {
            Reflect.deleteProperty(process.env, AGENT_RULES_HINT_ENV);
        } else {
            process.env[AGENT_RULES_HINT_ENV] = previous;
        }
    });

    it("returns true once, then false for the rest of the process", () => {
        expect.assertions(3);

        Reflect.deleteProperty(process.env, AGENT_RULES_HINT_ENV);

        expect(claimAgentRulesHint()).toBe(true);
        expect(claimAgentRulesHint()).toBe(false);
        expect(process.env[AGENT_RULES_HINT_ENV]).toBe("1");
    });
});
