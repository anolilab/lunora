import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ActivityFeed } from "../../src/react/activity";
import { AdminOrganizations } from "../../src/react/admin";
import { OverviewStats } from "../../src/react/overview";
import { ProjectsCard } from "../../src/react/projects";
import { activity, CREATED_SENTENCE, HOUR, noop, NOW, organization, project } from "../cards.fixtures";

describe("overviewStats", () => {
    it("explains an empty tenant instead of showing it four zeroes", () => {
        render(<OverviewStats now={NOW} payload={{ activity: [], projects: [] }} />);

        expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
    });

    it("renders a tile per derived stat", () => {
        render(<OverviewStats now={NOW} payload={{ activity: [], projects: [project("Alpha")] }} />);

        expect(screen.getByText("Active projects")).toBeInTheDocument();
        expect(screen.getByText("People active")).toBeInTheDocument();
    });

    it("marks itself busy while the query is undefined", () => {
        const { container } = render(<OverviewStats now={NOW} payload={undefined} />);

        expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    });
});

describe("projectsCard", () => {
    it("hides the write controls rather than disabling them", () => {
        render(<ProjectsCard canWrite={false} onArchive={noop} onCreate={noop} rows={[project("Alpha")]} />);

        expect(screen.queryByText("Create")).not.toBeInTheDocument();
        expect(screen.queryByText("Archive")).not.toBeInTheDocument();
    });

    it("rejects an empty name in the browser, without calling the server", () => {
        const onCreate = vi.fn(noop);

        render(<ProjectsCard canWrite onArchive={noop} onCreate={onCreate} rows={[]} />);
        fireEvent.click(screen.getByText("Create"));

        expect(screen.getByRole("alert")).toHaveTextContent("Give the project a name.");
        expect(onCreate).not.toHaveBeenCalled();
    });

    it("submits a trimmed name", async () => {
        const onCreate = vi.fn(noop);

        render(<ProjectsCard canWrite onArchive={noop} onCreate={onCreate} rows={[]} />);
        fireEvent.change(screen.getByPlaceholderText("Website redesign"), { target: { value: "  Website  " } });
        fireEvent.click(screen.getByText("Create"));
        await vi.waitFor(() => {
            expect(onCreate).toHaveBeenCalledWith("Website");
        });
    });

    it("keeps the typed name across a new onCreate, and submits into the latest one", async () => {
        const first = vi.fn(noop);
        const latest = vi.fn(noop);
        const { rerender } = render(<ProjectsCard canWrite onArchive={noop} onCreate={first} rows={[]} />);

        fireEvent.change(screen.getByPlaceholderText("Website redesign"), { target: { value: "Website" } });
        rerender(<ProjectsCard canWrite onArchive={noop} onCreate={latest} rows={[]} />);

        expect(screen.getByPlaceholderText("Website redesign")).toHaveValue("Website");

        fireEvent.click(screen.getByText("Create"));
        await vi.waitFor(() => {
            expect(latest).toHaveBeenCalledWith("Website");
        });

        expect(first).not.toHaveBeenCalled();
    });

    it("filters by the search box and hides archived rows by default", () => {
        render(<ProjectsCard canWrite={false} onArchive={noop} onCreate={noop} rows={[project("Alpha"), project("Beta", { archivedAt: NOW })]} />);

        expect(screen.queryByText("Beta")).not.toBeInTheDocument();

        fireEvent.change(screen.getByLabelText("Search projects"), { target: { value: "zzz" } });

        expect(screen.getByText("Nothing matches that search")).toBeInTheDocument();
    });

    it("archives through the callback it was given", () => {
        const onArchive = vi.fn(noop);

        render(<ProjectsCard canWrite onArchive={onArchive} onCreate={noop} rows={[project("Alpha")]} />);
        fireEvent.click(screen.getByText("Archive"));

        expect(onArchive).toHaveBeenCalledWith("p-Alpha");
    });
});

describe("activityFeed", () => {
    it("renders a sentence, not an identifier", () => {
        render(<ActivityFeed now={NOW} resolveActor={() => "Ada Lovelace"} rows={[activity("project.created", NOW - HOUR, { name: "Website" })]} />);

        expect(screen.getByText(CREATED_SENTENCE)).toBeInTheDocument();
        expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
        expect(screen.getByText("1h ago")).toBeInTheDocument();
    });

    it("says so when there is nothing", () => {
        render(<ActivityFeed now={NOW} rows={[]} />);

        expect(screen.getByText("No activity yet")).toBeInTheDocument();
    });
});

describe("adminOrganizations", () => {
    it("totals seats across tenants and filters by plan", () => {
        render(<AdminOrganizations now={NOW} rows={[organization("Acme", "pro", 12), organization("Globex", "free", 3)]} />);

        expect(screen.getByText("2 organizations · 15 seats")).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText("Filter by plan"), { target: { value: "free" } });

        expect(screen.queryByText("Acme")).not.toBeInTheDocument();
        expect(screen.getByText("Globex")).toBeInTheDocument();
    });
});
