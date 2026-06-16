import { useMutation, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import { DeploymentsSection } from "./DeploymentsSection";
import type { OrgId, ProjectId } from "./types";

interface ProjectsSectionProps {
    organizationId: OrgId;
}

/** Derive a url-safe slug from a free-text name (shared shape with org slugs). */
const slugify = (value: string): string => {
    let out = "";
    let lastDash = false;

    for (const char of value.toLowerCase()) {
        const ok = (char >= "a" && char <= "z") || (char >= "0" && char <= "9");

        if (ok) {
            out += char;
            lastDash = false;
        } else if (!lastDash && out.length > 0) {
            out += "-";
            lastDash = true;
        }
    }

    while (out.endsWith("-")) {
        out = out.slice(0, -1);
    }

    return out;
};

/**
 * Projects tab: the org's projects (live), an inline create form, and — when a
 * project is selected — its {@link DeploymentsSection}.
 */
export const ProjectsSection = ({ organizationId }: ProjectsSectionProps): ReactElement => {
    const projects = useQuery(api.projects.listByOrg, { organizationId });
    const createProject = useMutation(api.projects.create);

    const [name, setName] = useState("");
    const [slug, setSlug] = useState("");
    const [githubRepo, setGithubRepo] = useState("");
    const [framework, setFramework] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [activeProject, setActiveProject] = useState<ProjectId | null>(null);

    if (activeProject) {
        const project = projects?.find((candidate) => candidate._id === activeProject);

        return (
            <DeploymentsSection
                onBack={() => {
                    setActiveProject(null);
                }}
                organizationId={organizationId}
                projectId={activeProject}
                projectName={project?.name ?? "Project"}
            />
        );
    }

    const effectiveSlug = slug.trim() === "" ? slugify(name) : slug;

    return (
        <div className="stack">
            <section className="card">
                <h3>Projects</h3>
                <AsyncList
                    empty="No projects yet."
                    render={(rows) => (
                        <ul className="list">
                            {rows.map((project) => (
                                <li key={project._id}>
                                    <button
                                        className="row-button"
                                        onClick={() => {
                                            setActiveProject(project._id);
                                        }}
                                        type="button"
                                    >
                                        <span className="row-title">{project.name}</span>
                                        <span className="muted">/{project.slug}</span>
                                        {project.githubRepo ? <span className="badge">{project.githubRepo}</span> : null}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    rows={projects}
                />
            </section>

            <section className="card">
                <h3>New project</h3>
                <form
                    className="form-grid"
                    onSubmit={(event) => {
                        event.preventDefault();
                        setError(null);

                        void (async () => {
                            try {
                                await createProject.mutate({
                                    framework: framework.trim() || undefined,
                                    githubRepo: githubRepo.trim() || undefined,
                                    name,
                                    organizationId,
                                    slug: effectiveSlug,
                                });
                                setName("");
                                setSlug("");
                                setGithubRepo("");
                                setFramework("");
                            } catch (error_: unknown) {
                                setError(error_ instanceof Error ? error_.message : "create failed");
                            }
                        })();
                    }}
                >
                    <label htmlFor="project-name">
                        Name
                        <input
                            id="project-name"
                            onChange={(event) => {
                                setName(event.target.value);
                            }}
                            required
                            value={name}
                        />
                    </label>
                    <label htmlFor="project-slug">
                        Slug
                        <input
                            id="project-slug"
                            onChange={(event) => {
                                setSlug(event.target.value);
                            }}
                            placeholder={slugify(name) || "my-app"}
                            value={slug}
                        />
                    </label>
                    <label htmlFor="project-repo">
                        GitHub repo
                        <input
                            id="project-repo"
                            onChange={(event) => {
                                setGithubRepo(event.target.value);
                            }}
                            placeholder="owner/repo"
                            value={githubRepo}
                        />
                    </label>
                    <label htmlFor="project-framework">
                        Framework
                        <input
                            id="project-framework"
                            onChange={(event) => {
                                setFramework(event.target.value);
                            }}
                            placeholder="optional"
                            value={framework}
                        />
                    </label>
                    <button className="primary" disabled={createProject.pending} type="submit">
                        {createProject.pending ? "Creating…" : "Create project"}
                    </button>
                    {error ? (
                        <p className="error" role="alert">
                            {error}
                        </p>
                    ) : null}
                </form>
            </section>
        </div>
    );
};
