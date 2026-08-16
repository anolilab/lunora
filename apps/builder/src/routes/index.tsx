import { useMutation, useQuery } from "@lunora/react";
import { createFileRoute } from "@tanstack/react-router";
import type { ChangeEventHandler, FormEventHandler, JSX } from "react";
import { useCallback, useState } from "react";

import { api } from "#lunora/_generated/api.js";

/**
 * The project list, split out so the loading, empty and populated states are
 * three sibling returns rather than a nested ternary in the middle of the page.
 */
const ProjectList = ({ projects }: { projects: ReadonlyArray<{ _id: string; name: string; template: string }> | undefined }): JSX.Element => {
    if (projects === undefined) {
        return <p className="muted">Loading projects…</p>;
    }

    if (projects.length === 0) {
        return <p className="muted">No projects yet. Describe one above.</p>;
    }

    return (
        <ul className="projects">
            {projects.map((project) => (
                <li key={project._id}>
                    <span className="project-name">{project.name}</span>
                    <span className="muted">{project.template}</span>
                </li>
            ))}
        </ul>
    );
};

/**
 * The project dashboard — the builder's front door, and for now the whole of it.
 *
 * `useQuery` here is a *live* subscription, not a fetch: creating a project
 * re-renders this list with no refetch and no cache invalidation, which is the
 * property the workbench (plan 335 W5) leans on for streamed file writes.
 */
const Dashboard = (): JSX.Element => {
    const projects = useQuery(api.projects.list, {});
    const { mutate: createProject } = useMutation(api.projects.create);
    const [name, setName] = useState("");

    const onNameChange: ChangeEventHandler<HTMLInputElement> = useCallback((event) => {
        setName(event.target.value);
    }, []);

    // Not an `async` handler: React's `onSubmit` expects a void return, and an
    // async one hands it a floating promise whose rejection nothing observes.
    const onSubmit: FormEventHandler<HTMLFormElement> = useCallback(
        (event) => {
            event.preventDefault();

            const trimmed = name.trim();

            if (trimmed.length === 0) {
                return;
            }

            // Clear first: the list is live, so leaving the field populated
            // would read as "not submitted yet" once the row appears.
            setName("");

            createProject({ name: trimmed }).catch((error: unknown) => {
                setName(trimmed);
                // eslint-disable-next-line no-console -- W5 replaces this with the workbench's error surface; until then a swallowed failure would look like a silent no-op
                console.error("Could not create the project", error);
            });
        },
        [createProject, name],
    );

    return (
        <main className="page">
            <header className="page-header">
                <h1>Lander</h1>
                <p className="muted">Describe an app, and land it on Cloudflare.</p>
            </header>

            <form className="new-project" onSubmit={onSubmit}>
                <input aria-label="New project name" onChange={onNameChange} placeholder="A todo app with sign-in…" value={name} />
                <button disabled={name.trim().length === 0} type="submit">
                    Create
                </button>
            </form>

            <ProjectList projects={projects?.projects} />
        </main>
    );
};

export const Route = createFileRoute("/")({ component: Dashboard });
