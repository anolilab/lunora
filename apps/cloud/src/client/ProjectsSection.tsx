import { Add01Icon, CloudUploadIcon, GithubIcon, GitlabIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Preloaded, ReturnOf } from "@lunora/client";
import { useMutation, usePreloadedQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { api } from "../../lunora/_generated/api.js";
import { DeploymentsSection } from "./DeploymentsSection";
import type { GitProvider } from "./ImportProjectDialog";
import { ImportProjectDialog } from "./ImportProjectDialog";
import { Field, FieldForm, FormError, interactiveRowClassName, RowList } from "./section-ui";
import type { OrgId, ProjectId } from "./types";

interface ProjectsSectionProps {
    organizationId: OrgId;
    /** SSR-preloaded projects: painted on the first render, then kept live. */
    preloaded: Preloaded<ReturnOf<typeof api.projects.listByOrg>>;
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
 * Projects tab: the org's projects (server-rendered, then live). The primary way
 * to add one is importing a repo from a git provider (GitHub / GitLab) via
 * {@link ImportProjectDialog}; a blank project stays available as a secondary
 * path. Selecting a project drills into its {@link DeploymentsSection}.
 */
/**
 * Which git host a project is linked to.
 *
 * The design session carried a `gitProvider` column on `projects`; this branch's
 * schema never gained one, and the only thing the UI does with it is choose a glyph.
 * Deriving it from the stored repo slug keeps the visual behaviour without a schema
 * change and a migration for one badge.
 */
const gitProviderOf = (repo: string | undefined): "github" | "gitlab" | undefined => {
    if (repo === undefined || repo === "") {
        return undefined;
    }

    return repo.includes("gitlab") ? "gitlab" : "github";
};

export const ProjectsSection = ({ organizationId, preloaded }: ProjectsSectionProps): ReactElement => {
    const projects = usePreloadedQuery(preloaded);
    const createProject = useMutation(api.projects.create);

    const [name, setName] = useState("");
    const [slug, setSlug] = useState("");
    const [framework, setFramework] = useState("");
    const [error, setError] = useState<null | string>(null);
    const [showBlank, setShowBlank] = useState(false);
    const [activeProject, setActiveProject] = useState<null | ProjectId>(null);

    // Import dialog: `seq` remounts it fresh each open so its step/fields reset;
    // `provider` preselects (from a provider button) or is null (show the picker).
    const [importOpen, setImportOpen] = useState(false);
    const [importProvider, setImportProvider] = useState<GitProvider | null>(null);
    const [importSeq, setImportSeq] = useState(0);

    const openImport = (provider: GitProvider | null): void => {
        setImportProvider(provider);
        setImportSeq((value) => value + 1);
        setImportOpen(true);
    };

    if (activeProject) {
        const project = projects?.find((candidate) => candidate._id === activeProject);

        return (
            <DeploymentsSection
                githubRepo={project?.githubRepo}
                gitProvider={gitProviderOf(project?.githubRepo)}
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
        <div className="flex flex-col gap-6">
            <Card>
                <CardHeader>
                    <CardTitle>Projects</CardTitle>
                    <CardAction className="flex gap-2">
                        <Button
                            onClick={() => {
                                setShowBlank((value) => !value);
                            }}
                            size="sm"
                            variant="ghost"
                        >
                            Blank project
                        </Button>
                        <Button
                            onClick={() => {
                                openImport(null);
                            }}
                            size="sm"
                        >
                            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                            Import
                        </Button>
                    </CardAction>
                </CardHeader>
                <CardContent>
                    {projects.length === 0 ? (
                        <div className="flex flex-col items-center gap-4 py-12 text-center">
                            <div className="grid size-12 place-items-center rounded-md border border-border text-muted-foreground">
                                <HugeiconsIcon icon={CloudUploadIcon} strokeWidth={2} />
                            </div>
                            <div className="grid gap-1">
                                <p className="text-sm font-medium">Import your first project</p>
                                <p className="max-w-xs text-sm text-muted-foreground">
                                    Connect a repository from GitHub or GitLab to deploy — no manual setup.
                                </p>
                            </div>
                            <div className="flex flex-wrap justify-center gap-2">
                                <Button
                                    onClick={() => {
                                        openImport("github");
                                    }}
                                >
                                    <HugeiconsIcon icon={GithubIcon} strokeWidth={2} />
                                    Import from GitHub
                                </Button>
                                <Button
                                    onClick={() => {
                                        openImport("gitlab");
                                    }}
                                    variant="outline"
                                >
                                    <HugeiconsIcon icon={GitlabIcon} strokeWidth={2} />
                                    GitLab
                                </Button>
                            </div>
                            <button
                                className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                                onClick={() => {
                                    setShowBlank(true);
                                }}
                                type="button"
                            >
                                or create a blank project
                            </button>
                        </div>
                    ) : (
                        <RowList>
                            {projects.map((project) => (
                                <li key={project._id}>
                                    <button
                                        className={interactiveRowClassName}
                                        onClick={() => {
                                            setActiveProject(project._id);
                                        }}
                                        type="button"
                                    >
                                        <span className="shrink-0 font-medium">{project.name}</span>
                                        <span className="text-muted-foreground">/{project.slug}</span>
                                        {project.githubRepo ? (
                                            <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                                                <HugeiconsIcon
                                                    className="size-3.5 shrink-0"
                                                    icon={gitProviderOf(project.githubRepo) === "gitlab" ? GitlabIcon : GithubIcon}
                                                    strokeWidth={2}
                                                />
                                                {project.githubRepo}
                                            </span>
                                        ) : null}
                                    </button>
                                </li>
                            ))}
                        </RowList>
                    )}
                </CardContent>
            </Card>

            {showBlank ? (
                <Card>
                    <CardHeader>
                        <CardTitle>New blank project</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <FieldForm
                            action={() => {
                                setError(null);

                                void (async () => {
                                    try {
                                        const id = await createProject.mutate({
                                            framework: framework.trim() || undefined,
                                            name,
                                            organizationId,
                                            slug: effectiveSlug,
                                        });
                                        setName("");
                                        setSlug("");
                                        setFramework("");
                                        setShowBlank(false);
                                        setActiveProject(id);
                                    } catch (error_: unknown) {
                                        setError(error_ instanceof Error ? error_.message : "create failed");
                                    }
                                })();
                            }}
                        >
                            <Field htmlFor="project-name" label="Name">
                                <Input
                                    id="project-name"
                                    onChange={(event) => {
                                        setName(event.target.value);
                                    }}
                                    required
                                    value={name}
                                />
                            </Field>
                            <Field htmlFor="project-slug" label="Slug">
                                <Input
                                    id="project-slug"
                                    onChange={(event) => {
                                        setSlug(event.target.value);
                                    }}
                                    placeholder={slugify(name) || "my-app"}
                                    value={slug}
                                />
                            </Field>
                            <Field htmlFor="project-framework" label="Framework">
                                <Input
                                    id="project-framework"
                                    onChange={(event) => {
                                        setFramework(event.target.value);
                                    }}
                                    placeholder="optional"
                                    value={framework}
                                />
                            </Field>
                            <Button className="justify-self-start" disabled={createProject.pending} type="submit">
                                {createProject.pending ? "Creating…" : "Create project"}
                            </Button>
                            <FormError message={error} />
                        </FieldForm>
                    </CardContent>
                </Card>
            ) : null}

            <ImportProjectDialog
                key={importSeq}
                onImported={(id) => {
                    setImportOpen(false);
                    setActiveProject(id);
                }}
                onOpenChange={setImportOpen}
                open={importOpen}
                organizationId={organizationId}
                provider={importProvider}
            />
        </div>
    );
};
