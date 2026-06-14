import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AGENT_RULES_DIR, CIRRUS_SKILL_NAMES, detectAgentRules } from "../src/agent-rules";

let workdir: string;

/** Write `&lt;workdir>/.agents/skills/&lt;name>/SKILL.md`. */
const installSkill = (name: string): void => {
    const directory = join(workdir, AGENT_RULES_DIR, name);

    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), `# ${name}\n`, "utf8");
};

describe("detectAgentRules", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-agent-rules-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reports not installed for an empty project", () => {
        expect.assertions(3);

        const status = detectAgentRules(workdir);

        expect(status.installed).toBe(false);
        expect(status.present).toHaveLength(0);
        expect(status.missing).toStrictEqual([...CIRRUS_SKILL_NAMES]);
    });

    it("counts the router skill as installed even when others are missing", () => {
        expect.assertions(3);

        installSkill("cirrus");

        const status = detectAgentRules(workdir);

        expect(status.installed).toBe(true);
        expect(status.present).toStrictEqual(["cirrus"]);
        expect(status.missing).not.toContain("cirrus");
    });

    it("lists every installed skill as present", () => {
        expect.assertions(2);

        for (const name of CIRRUS_SKILL_NAMES) {
            installSkill(name);
        }

        const status = detectAgentRules(workdir);

        expect(status.installed).toBe(true);
        expect(status.present).toStrictEqual([...CIRRUS_SKILL_NAMES]);
    });
});
