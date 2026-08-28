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
import { OnboardingChecklist } from "./OnboardingChecklist";
import { interactiveRowClassName } from "./section-styles";
import { Field, FieldForm, FormError, RowList } from "./section-ui";
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

/** A blank new-project draft — the initial value and what a successful create resets to. */
const EMPTY_DRAFT = { framework: "", name: "", slug: "" };

export const ProjectsSection = ({ organizationId, preloaded }: ProjectsSectionProps): ReactElement => {
    const projects = usePreloadedQuery(preloaded);
    const createProject = useMutation(api.projects.create);

    // The three new-project fields are one draft: they are filled together, cleared
    // together on success, and never meaningfully change apart.
    const [draft, setDraft] = useState(EMPTY_DRAFT);
    const [error, setError] = useState<null | string>(null);
    const [showBlank, setShowBlank] = useState(false);
    const [activeProject, setActiveProject] = useState<null | ProjectId>(null);

    // Import dialog: one value, because the three fields only ever change together —
    // three setters in a row is three chances to leave them inconsistent. `seq`
    // remounts the dialog fresh each open so its step/fields reset; `provider`
    // preselects (from a provider button) or is null (show the picker).
    const [importDialog, setImportDialog] = useState<{ open: boolean; provider: GitProvider | null; seq: number }>({
        open: false,
        provider: null,
        seq: 0,
    });

    const openImport = (provider: GitProvider | null): void => {
        setImportDialog((current) => {
            return { open: true, provider, seq: current.seq + 1 };
        });
    };

    const setImportOpen = (open: boolean): void => {
        setImportDialog((current) => {
            return { ...current, open };
        });
    };

    if (activeProject) {
        const project = projects?.find((candidate) => candidate._id === activeProject);

        return (
            <DeploymentsSection
                activeDeploymentId={project?.activeDeploymentId}
                githubRepo={project?.githubRepo}
                gitProvider={gitProviderOf(project?.githubRepo)}
                onBack={() => {
                    setActiveProject(null);
                }}
                organizationId={organizationId}
                previewProtected={project?.previewProtected ?? false}
                projectId={activeProject}
                projectName={project?.name ?? "Project"}
                rollout={project?.rollout}
            />
        );
    }

    const effectiveSlug = draft.slug.trim() === "" ? slugify(draft.name) : draft.slug;

    return (
        <div className="flex flex-col gap-6">
            {/* Above the list until the org's first deployment is live, then gone. */}
            <OnboardingChecklist organizationId={organizationId} />

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
                                            framework: draft.framework.trim() || undefined,
                                            name: draft.name,
                                            organizationId,
                                            slug: effectiveSlug,
                                        });
                                        setDraft(EMPTY_DRAFT);
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
                                        setDraft((current) => {
                                            return { ...current, name: event.target.value };
                                        });
                                    }}
                                    required
                                    value={draft.name}
                                />
                            </Field>
                            <Field htmlFor="project-slug" label="Slug">
                                <Input
                                    id="project-slug"
                                    onChange={(event) => {
                                        setDraft((current) => {
                                            return { ...current, slug: event.target.value };
                                        });
                                    }}
                                    placeholder={slugify(draft.name) || "my-app"}
                                    value={draft.slug}
                                />
                            </Field>
                            <Field htmlFor="project-framework" label="Framework">
                                <Input
                                    id="project-framework"
                                    onChange={(event) => {
                                        setDraft((current) => {
                                            return { ...current, framework: event.target.value };
                                        });
                                    }}
                                    placeholder="optional"
                                    value={draft.framework}
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
                key={importDialog.seq}
                onImported={(id) => {
                    setImportOpen(false);
                    setActiveProject(id);
                }}
                onOpenChange={setImportOpen}
                open={importDialog.open}
                organizationId={organizationId}
                provider={importDialog.provider}
            />
        </div>
    );
};
