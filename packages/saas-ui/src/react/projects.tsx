"use client";

import type { ReactNode } from "react";
import { useId, useState } from "react";

import type { ProjectRow, ProjectsView } from "../core";
import { createProjectFormController, DEFAULT_VIEW, NAME_MAX_LENGTH, projectCounts, selectProjects } from "../core";
import { Card, Empty, FieldError } from "./primitives";
import { useForm } from "./use-form";

interface ProjectsCardProps {
    /** Whether the caller may create and archive. False hides the controls entirely. */
    canWrite: boolean;
    onArchive: (projectId: string) => Promise<unknown>; // secret-scanner:allow -- `projectId` is a parameter name in a function type, not a Cypress project id.
    onCreate: (name: string) => Promise<unknown>;
    rows: ReadonlyArray<ProjectRow> | undefined;
}

/**
 * The project list: a create form, a search/sort toolbar, and the rows.
 *
 * `canWrite` hides the controls rather than disabling them. A disabled button is
 * a promise the server will refuse to keep — the mutation checks the role
 * anyway, so showing a member a greyed-out "New project" only teaches them the
 * product is broken for them.
 */
const ProjectsCard = ({ canWrite, onArchive, onCreate, rows }: ProjectsCardProps): ReactNode => {
    const [view, setView] = useState<ProjectsView>(DEFAULT_VIEW);
    const nameId = useId();
    const archivedId = useId();
    const [form, controller] = useForm(
        () =>
            createProjectFormController(onCreate, () => {
                controller.reset();
            }),
        [onCreate],
    );

    if (!rows) {
        return (
            <Card title="Projects">
                <div aria-busy="true" className="lu-saas-list lu-saas-list--loading" />
            </Card>
        );
    }

    const counts = projectCounts(rows);
    const visible = selectProjects(rows, view);

    return (
        <Card subtitle={`${counts.active.toString()} active · ${counts.archived.toString()} archived`} title="Projects">
            {canWrite ? (
                <form
                    className="lu-saas-newproject"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void controller.submit();
                    }}
                >
                    <label className="lu-saas-label" htmlFor={nameId}>
                        New project
                        <input
                            aria-describedby={(form.errors.name ?? form.formError) ? `${nameId}-error` : undefined}
                            aria-invalid={form.errors.name === undefined ? undefined : true}
                            className="lu-saas-input"
                            disabled={form.status === "busy"}
                            id={nameId}
                            maxLength={NAME_MAX_LENGTH}
                            onChange={(event) => {
                                controller.setValue("name", event.target.value);
                            }}
                            placeholder="Website redesign"
                            value={form.values.name}
                        />
                    </label>
                    <button className="lu-saas-button" disabled={form.status === "busy"} type="submit">
                        {form.status === "busy" ? "Creating…" : "Create"}
                    </button>
                    <FieldError id={`${nameId}-error`} message={form.errors.name ?? form.formError} />
                </form>
            ) : undefined}

            <div className="lu-saas-toolbar">
                <input
                    aria-label="Search projects"
                    className="lu-saas-input"
                    onChange={(event) => {
                        setView({ ...view, search: event.target.value });
                    }}
                    placeholder="Search"
                    type="search"
                    value={view.search}
                />
                <select
                    aria-label="Sort projects"
                    className="lu-saas-select"
                    onChange={(event) => {
                        setView({ ...view, sort: event.target.value as ProjectsView["sort"] });
                    }}
                    value={view.sort}
                >
                    <option value="newest">Newest</option>
                    <option value="oldest">Oldest</option>
                    <option value="name">Name</option>
                </select>
                <label className="lu-saas-checkbox" htmlFor={archivedId}>
                    <input
                        checked={view.includeArchived}
                        id={archivedId}
                        onChange={(event) => {
                            setView({ ...view, includeArchived: event.target.checked });
                        }}
                        type="checkbox"
                    />
                    Show archived
                </label>
            </div>

            {visible.length === 0 ? (
                <Empty title={counts.total === 0 ? "No projects yet" : "Nothing matches that search"} />
            ) : (
                <ul className="lu-saas-list">
                    {visible.map((project) => (
                        <li className={project.archivedAt ? "lu-saas-row lu-saas-row--archived" : "lu-saas-row"} key={project._id}>
                            <span className="lu-saas-row__name">{project.name}</span>
                            <code className="lu-saas-row__slug">{project.slug}</code>
                            {canWrite && !project.archivedAt ? (
                                <button
                                    className="lu-saas-button lu-saas-button--quiet"
                                    onClick={() => {
                                        void onArchive(project._id);
                                    }}
                                    type="button"
                                >
                                    Archive
                                </button>
                            ) : undefined}
                        </li>
                    ))}
                </ul>
            )}
        </Card>
    );
};

export type { ProjectsCardProps };
export { ProjectsCard };
