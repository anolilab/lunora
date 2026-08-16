import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BUILDER_INSTRUCTIONS, builderSkills, INSTRUCTION_BUDGET, instructionSize, selectSkills } from "../lunora/skills";
import { SKILL_SOURCES } from "../lunora/skills.generated";

const skillsRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "packages", "cli", "skills");

describe("skill corpus", () => {
    it("compiles every selected source into a skill", () => {
        expect.assertions(2);

        expect(builderSkills).toHaveLength(SKILL_SOURCES.length);
        expect(builderSkills.every((skill) => skill.name.length > 0)).toBe(true);
    });

    it("names skills that actually exist in packages/cli/skills", () => {
        expect.assertions(1);

        // The generated module is committed, so it can drift from the corpus it
        // was built from — a renamed or deleted skill would otherwise be caught
        // only when `build:skills` next ran, which might be much later.
        const available = new Set(
            readdirSync(skillsRoot, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name),
        );
        const missing = SKILL_SOURCES.map((source) => source.name).filter((name) => !available.has(name));

        expect(missing).toStrictEqual([]);
    });

    it("stays inside the instruction budget", () => {
        expect.assertions(2);

        // Every skill's text rides along on every turn. This is the guard against
        // the corpus growing until a build request cannot fit its own context.
        expect(instructionSize()).toBeLessThan(INSTRUCTION_BUDGET);
        expect(instructionSize()).toBeGreaterThan(1000);
    });

    it("keeps the agent's own instructions short, because the skills carry the detail", () => {
        expect.assertions(2);

        // If this grows past a couple of thousand characters it is a sign that
        // framework knowledge is being written here instead of in the corpus,
        // which is exactly the second-source-of-truth D4 rejects.
        expect(BUILDER_INSTRUCTIONS.length).toBeLessThan(2000);
        expect(BUILDER_INSTRUCTIONS).toContain("verify");
    });
});

describe("selectSkills", () => {
    it("always includes the function-authoring rules", () => {
        expect.assertions(2);

        expect(selectSkills("make the button blue")).toContain("lunora-functions");
        expect(selectSkills("")).toContain("lunora-functions");
    });

    it.each([
        ["add sign-in with email", "lunora-setup-auth"],
        ["let users upload an avatar image", "lunora-setup-storage"],
        ["send an invite email", "lunora-setup-mail"],
        ["deploy this to production", "lunora-deploy"],
        ["show presence for everyone in the room", "lunora-realtime"],
        ["run a cron job every night", "lunora-setup-scheduler"],
    ])("picks the right skill for %j", (prompt, expected) => {
        expect.assertions(1);

        expect(selectSkills(prompt)).toContain(expected);
    });

    it("does not pull in unrelated skills", () => {
        expect.assertions(2);

        const picked = selectSkills("rename the heading");

        expect(picked).not.toContain("lunora-deploy");
        expect(picked).not.toContain("lunora-setup-storage");
    });
});
