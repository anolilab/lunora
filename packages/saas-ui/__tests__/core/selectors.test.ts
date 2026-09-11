import { describe, expect, it } from "vitest";

import { describeActivity, groupActivityByDay } from "../../src/core/activity";
import { adminTotals, planOptions, selectOrganizations } from "../../src/core/admin-organizations";
import { dayKey, initials, planLabel, relativeTime } from "../../src/core/format";
import { deriveOverviewStats, isFirstRun } from "../../src/core/overview";
import { projectCounts, selectProjects } from "../../src/core/projects";
import type { ActivityRow, OrganizationRow, ProjectRow } from "../../src/core/types";

const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const project = (overrides: Partial<ProjectRow> & { name: string }): ProjectRow => {
    return {
        _creationTime: NOW,
        _id: `p-${overrides.name}`,
        createdBy: "u1",
        organizationId: "org1",
        slug: overrides.name.toLowerCase(),
        ...overrides,
    };
};

const activity = (overrides: Partial<ActivityRow> & { action: string; createdAt: number }): ActivityRow => {
    return {
        _creationTime: overrides.createdAt,
        _id: `a-${overrides.createdAt.toString()}-${overrides.action}`,
        actorId: "u1",
        organizationId: "org1",
        subjectType: "project",
        ...overrides,
    };
};

const organization = (overrides: Partial<OrganizationRow> & { name: string }): OrganizationRow => {
    return {
        _creationTime: NOW,
        _id: `o-${overrides.name}`,
        organizationId: `org-${overrides.name}`,
        plan: "free",
        seats: 1,
        slug: overrides.name.toLowerCase(),
        status: "active",
        updatedAt: NOW,
        ...overrides,
    };
};

describe("selectProjects", () => {
    const rows = [
        project({ _creationTime: NOW - 2 * DAY, name: "Alpha" }),
        project({ archivedAt: NOW - HOUR, name: "Beta" }),
        project({ _creationTime: NOW - DAY, name: "Gamma" }),
    ];

    it("hides archived projects by default", () => {
        expect(selectProjects(rows).map((p) => p.name)).toStrictEqual(["Gamma", "Alpha"]);
    });

    it("includes archived when asked", () => {
        expect(selectProjects(rows, { includeArchived: true, search: "", sort: "name" }).map((p) => p.name)).toStrictEqual(["Alpha", "Beta", "Gamma"]);
    });

    it("matches name or slug, case-insensitively", () => {
        expect(selectProjects(rows, { includeArchived: true, search: "  BET ", sort: "name" }).map((p) => p.name)).toStrictEqual(["Beta"]);
    });

    it("does not mutate the caller's array — it is the live query's", () => {
        const original = [...rows];

        selectProjects(rows, { includeArchived: true, search: "", sort: "name" });

        expect(rows).toStrictEqual(original);
    });

    it("counts from the unfiltered rows", () => {
        expect(projectCounts(rows)).toStrictEqual({ active: 2, archived: 1, total: 3 });
    });
});

describe("groupActivityByDay", () => {
    it("groups consecutive rows by day, preserving server order", () => {
        const groups = groupActivityByDay(
            [
                activity({ action: "project.created", createdAt: NOW - HOUR, meta: { name: "Website" } }),
                activity({ action: "project.archived", createdAt: NOW - 2 * HOUR }),
                activity({ action: "member.joined", createdAt: NOW - 30 * HOUR }),
            ],
            NOW,
        );

        expect(groups).toHaveLength(2);
        expect(groups[0]!.day).toBe(dayKey(NOW));
        expect(groups[0]!.entries.map((entry) => entry.sentence)).toStrictEqual(["created the project Website", "archived the project"]);
        expect(groups[0]!.entries[0]!.when).toBe("1h ago");
        expect(groups[1]!.entries[0]!.sentence).toBe("joined the organization");
    });

    it("renders an unknown action as a sentence rather than an identifier", () => {
        expect(describeActivity(activity({ action: "invoice.paid", createdAt: NOW }))).toBe("paid the invoice");
    });

    it("falls back to the raw action when it has no verb", () => {
        expect(describeActivity(activity({ action: "something", createdAt: NOW }))).toBe("something");
    });
});

describe("deriveOverviewStats", () => {
    it("counts projects, today's events and the week's distinct actors", () => {
        const payload = {
            activity: [
                activity({ action: "project.created", actorId: "u1", createdAt: NOW - HOUR }),
                activity({ action: "project.created", actorId: "u2", createdAt: NOW - 3 * DAY }),
                activity({ action: "project.created", actorId: "u1", createdAt: NOW - 30 * DAY }),
            ],
            projects: [project({ name: "Alpha" }), project({ archivedAt: NOW, name: "Beta" })],
        };

        expect(deriveOverviewStats(payload, NOW).map((tile) => [tile.id, tile.value])).toStrictEqual([
            ["projects", 1],
            ["archived", 1],
            ["activity", 1],
            ["actors", 2],
        ]);
    });

    it("recognises a brand-new tenant instead of showing it four zeroes", () => {
        expect(isFirstRun({ activity: [], projects: [] })).toBe(true);
        expect(isFirstRun({ activity: [], projects: [project({ name: "Alpha" })] })).toBe(false);
    });
});

describe("admin organisations", () => {
    const rows = [
        organization({ name: "Acme", plan: "pro", seats: 12, updatedAt: NOW - DAY }),
        organization({ name: "Globex", plan: "free", seats: 3, updatedAt: NOW }),
        organization({ name: "Initech", plan: "pro", seats: 40, status: "past_due", updatedAt: NOW - 2 * DAY }),
    ];

    it("filters by plan, status and search together", () => {
        expect(selectOrganizations(rows, { plan: "pro", search: "", sort: "seats", status: "active" }).map((o) => o.name)).toStrictEqual(["Acme"]);
    });

    it("sorts by seats descending", () => {
        expect(selectOrganizations(rows, { plan: "all", search: "", sort: "seats", status: "all" }).map((o) => o.name)).toStrictEqual([
            "Initech",
            "Acme",
            "Globex",
        ]);
    });

    it("offers every present plan, labelled, with an all option first", () => {
        expect(planOptions(rows)).toStrictEqual([
            { label: "All plans", value: "all" },
            { label: "Free", value: "free" },
            { label: "Pro", value: "pro" },
        ]);
    });

    it("sums seats across tenants", () => {
        expect(adminTotals(rows)).toStrictEqual({ organizations: 3, seats: 55 });
    });
});

describe("format", () => {
    it("reads as elapsed time up to a week, then as a date", () => {
        expect(relativeTime(NOW, NOW)).toBe("just now");
        expect(relativeTime(NOW - 4 * 60_000, NOW)).toBe("4m ago");
        expect(relativeTime(NOW - 5 * HOUR, NOW)).toBe("5h ago");
        expect(relativeTime(NOW - 3 * DAY, NOW)).toBe("3d ago");
        expect(relativeTime(NOW - 30 * DAY, NOW)).toBe("2026-08-12");
    });

    it("never returns a future duration for a clock that is behind", () => {
        expect(relativeTime(NOW + HOUR, NOW)).toBe("just now");
    });

    it("takes at most two initials", () => {
        expect(initials("Ada Lovelace")).toBe("AL");
        expect(initials("  grace  brewster  murray hopper ")).toBe("GB");
        expect(initials("")).toBe("");
    });

    it("labels a plan id for display", () => {
        expect(planLabel("team_annual")).toBe("Team annual");
        expect(planLabel("")).toBe("Free");
    });
});
