import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import type { ActivityRow, OrganizationRow, ProjectRow } from "../../src/core";
import ActivityFeed from "../../src/svelte/ActivityFeed.svelte";
import AdminOrganizations from "../../src/svelte/AdminOrganizations.svelte";
import OverviewStats from "../../src/svelte/OverviewStats.svelte";
import ProjectsCard from "../../src/svelte/ProjectsCard.svelte";

/**
 * The Svelte port's tests deliberately assert the same behaviours as
 * `__tests__/react/cards.test.tsx`, against the same core. Where the two files
 * differ is only in how a click is dispatched — which is the claim the
 * core/view split makes, checked rather than asserted in a comment.
 */

const CREATED_SENTENCE = /created the project Website/u;
const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const HOUR = 3_600_000;

const project = (name: string, overrides: Partial<ProjectRow> = {}): ProjectRow => {
    return {
        _creationTime: NOW,
        _id: `p-${name}`,
        createdBy: "u1",
        name,
        organizationId: "org1",
        slug: name.toLowerCase(),
        ...overrides,
    };
};

const noop = async (): Promise<void> => {};

describe("overviewStats", () => {
    it("explains an empty tenant instead of showing it four zeroes", () => {
        render(OverviewStats, { now: NOW, payload: { activity: [], projects: [] } });

        expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
    });

    it("renders a tile per derived stat", () => {
        render(OverviewStats, { now: NOW, payload: { activity: [], projects: [project("Alpha")] } });

        expect(screen.getByText("Active projects")).toBeInTheDocument();
        expect(screen.getByText("People active")).toBeInTheDocument();
    });
});

describe("projectsCard", () => {
    it("hides the write controls rather than disabling them", () => {
        render(ProjectsCard, { canWrite: false, onArchive: noop, onCreate: noop, rows: [project("Alpha")] });

        expect(screen.queryByText("Create")).not.toBeInTheDocument();
        expect(screen.queryByText("Archive")).not.toBeInTheDocument();
    });

    it("rejects an empty name in the browser, without calling the server", async () => {
        const onCreate = vi.fn(noop);

        render(ProjectsCard, { canWrite: true, onArchive: noop, onCreate, rows: [] });
        await fireEvent.click(screen.getByText("Create"));

        expect(screen.getByRole("alert")).toHaveTextContent("Give the project a name.");
        expect(onCreate).not.toHaveBeenCalled();
    });

    it("submits a trimmed name", async () => {
        const onCreate = vi.fn(noop);

        render(ProjectsCard, { canWrite: true, onArchive: noop, onCreate, rows: [] });
        await fireEvent.input(screen.getByPlaceholderText("Website redesign"), { target: { value: "  Website  " } });
        await fireEvent.click(screen.getByText("Create"));
        await vi.waitFor(() => {
            expect(onCreate).toHaveBeenCalledWith("Website");
        });
    });

    it("hides archived rows by default and reports an empty search", async () => {
        render(ProjectsCard, { canWrite: false, onArchive: noop, onCreate: noop, rows: [project("Alpha"), project("Beta", { archivedAt: NOW })] });

        expect(screen.queryByText("Beta")).not.toBeInTheDocument();

        await fireEvent.input(screen.getByLabelText("Search projects"), { target: { value: "zzz" } });

        expect(screen.getByText("Nothing matches that search")).toBeInTheDocument();
    });

    it("archives through the callback it was given", async () => {
        const onArchive = vi.fn(noop);

        render(ProjectsCard, { canWrite: true, onArchive, onCreate: noop, rows: [project("Alpha")] });
        await fireEvent.click(screen.getByText("Archive"));

        expect(onArchive).toHaveBeenCalledWith("p-Alpha");
    });
});

describe("activityFeed", () => {
    const row = (action: string, createdAt: number, meta?: Record<string, unknown>): ActivityRow => {
        return {
            _creationTime: createdAt,
            _id: `a-${createdAt.toString()}`,
            action,
            actorId: "u1",
            createdAt,
            meta,
            organizationId: "org1",
            subjectType: "project",
        };
    };

    it("renders a sentence, not an identifier", () => {
        render(ActivityFeed, { now: NOW, resolveActor: () => "Ada Lovelace", rows: [row("project.created", NOW - HOUR, { name: "Website" })] });

        expect(screen.getByText(CREATED_SENTENCE)).toBeInTheDocument();
        expect(screen.getByText("1h ago")).toBeInTheDocument();
    });

    it("says so when there is nothing", () => {
        render(ActivityFeed, { now: NOW, rows: [] });

        expect(screen.getByText("No activity yet")).toBeInTheDocument();
    });
});

describe("adminOrganizations", () => {
    const organization = (name: string, plan: string, seats: number): OrganizationRow => {
        return {
            _creationTime: NOW,
            _id: `o-${name}`,
            name,
            organizationId: `org-${name}`,
            plan,
            seats,
            slug: name.toLowerCase(),
            status: "active",
            updatedAt: NOW,
        };
    };

    it("totals seats across tenants and filters by plan", async () => {
        render(AdminOrganizations, { now: NOW, rows: [organization("Acme", "pro", 12), organization("Globex", "free", 3)] });

        expect(screen.getByText("2 organizations · 15 seats")).toBeInTheDocument();

        await fireEvent.change(screen.getByLabelText("Filter by plan"), { target: { value: "free" } });

        expect(screen.queryByText("Acme")).not.toBeInTheDocument();
        expect(screen.getByText("Globex")).toBeInTheDocument();
    });
});
