import { ArrowLeft01Icon, GithubIcon, GitlabIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import { api } from "../../lunora/_generated/api.js";
import { Field, FieldForm, FormError } from "./section-ui";
import type { OrgId, ProjectId } from "./types";

export type GitProvider = "github" | "gitlab";

const PROVIDERS: ReadonlyArray<{ hint: string; icon: typeof GithubIcon; id: GitProvider; name: string }> = [
    { hint: "Push-to-deploy from a GitHub repository.", icon: GithubIcon, id: "github", name: "GitHub" },
    { hint: "Connect a GitLab repository (deploy via CLI).", icon: GitlabIcon, id: "gitlab", name: "GitLab" },
];

/** Derive a url-safe slug from a free-text name. */
const slugify = (value: string): string => {
    let out = "";
    let dash = false;

    for (const char of value.toLowerCase()) {
        if ((char >= "a" && char <= "z") || (char >= "0" && char <= "9")) {
            out += char;
            dash = false;
        } else if (!dash && out.length > 0) {
            out += "-";
            dash = true;
        }
    }

    while (out.endsWith("-")) {
        out = out.slice(0, -1);
    }

    return out;
};

const REPO_SCHEME_HOST = /^https?:\/\/[^/]+\//i;
const REPO_SSH_PREFIX = /^git@[^:]+:/i;
const REPO_GIT_SUFFIX = /\.git$/i;

/**
 * Parse `owner/name` out of a repo path or URL (`https://github.com/owner/name`,
 * `git@gitlab.com:owner/name.git`, or a bare `owner/name`). Returns `null` when
 * the input doesn't carry at least an owner and a name.
 */
const parseRepo = (input: string): null | string => {
    const stripped = input.trim().replace(REPO_SCHEME_HOST, "").replace(REPO_SSH_PREFIX, "").replace(REPO_GIT_SUFFIX, "");
    const parts = stripped.split("/").filter(Boolean);

    if (parts.length < 2) {
        return null;
    }

    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
};

interface ImportProjectDialogProps {
    onImported: (id: ProjectId) => void;
    onOpenChange: (open: boolean) => void;
    open: boolean;
    organizationId: OrgId;
    /** Preselect a provider (skips the picker). `null` opens on the provider step. */
    provider?: GitProvider | null;
}

/**
 * Import a project from a git provider instead of hand-creating one. Step 1 picks
 * the provider (GitHub / GitLab); step 2 takes the repository and a name and calls
 * `projects.create` wired to that repo. GitHub keys the push-to-deploy pipeline;
 * GitLab is stored and deployed via the CLI until its webhook lands. Remount with
 * a fresh `key` per open so the internal step/fields reset.
 */
export const ImportProjectDialog = ({ onImported, onOpenChange, open, organizationId, provider = null }: ImportProjectDialogProps): ReactElement => {
    const createProject = useMutation(api.projects.create);

    const [selected, setSelected] = useState<GitProvider | null>(provider);
    const [repo, setRepo] = useState("");
    const [name, setName] = useState("");
    const [framework, setFramework] = useState("");
    const [error, setError] = useState<null | string>(null);

    const activeProvider = PROVIDERS.find((entry) => entry.id === selected);
    const repoName = parseRepo(repo)?.split("/")[1] ?? "";

    return (
        <Dialog onOpenChange={onOpenChange} open={open}>
            <DialogContent className="sm:max-w-md">
                {selected === null || activeProvider === undefined ? (
                    <>
                        <DialogHeader>
                            <DialogTitle>Import a project</DialogTitle>
                            <DialogDescription>Connect a repository from your git provider.</DialogDescription>
                        </DialogHeader>
                        <div className="grid gap-2">
                            {PROVIDERS.map((entry) => (
                                <button
                                    className="flex items-center gap-3 rounded-md border border-border p-3 text-left transition-colors hover:bg-accent"
                                    key={entry.id}
                                    onClick={() => {
                                        setError(null);
                                        setSelected(entry.id);
                                    }}
                                    type="button"
                                >
                                    <HugeiconsIcon className="size-5 shrink-0" icon={entry.icon} strokeWidth={2} />
                                    <span className="flex flex-col">
                                        <span className="text-sm font-medium">{entry.name}</span>
                                        <span className="text-xs text-muted-foreground">{entry.hint}</span>
                                    </span>
                                </button>
                            ))}
                        </div>
                    </>
                ) : (
                    <>
                        <DialogHeader>
                            {provider === null ? (
                                <button
                                    className="flex w-fit cursor-pointer items-center gap-1 font-mono text-[11px] tracking-[0.06em] text-muted-foreground uppercase hover:text-foreground"
                                    onClick={() => {
                                        setSelected(null);
                                    }}
                                    type="button"
                                >
                                    <HugeiconsIcon className="size-3.5" icon={ArrowLeft01Icon} strokeWidth={2} />
                                    Providers
                                </button>
                            ) : null}
                            <DialogTitle className="flex items-center gap-2">
                                <HugeiconsIcon className="size-4" icon={activeProvider.icon} strokeWidth={2} />
                                Import from {activeProvider.name}
                            </DialogTitle>
                            <DialogDescription>Paste the repository URL, or enter it as owner/name.</DialogDescription>
                        </DialogHeader>

                        <FieldForm
                            className="max-w-none"
                            action={() => {
                                setError(null);

                                const parsed = parseRepo(repo);

                                if (parsed === null) {
                                    setError("Enter a repository as owner/name or a repo URL.");

                                    return;
                                }

                                const finalName = name.trim() === "" ? (parsed.split("/")[1] ?? parsed) : name.trim();

                                void (async () => {
                                    try {
                                        // `gitProvider` was a column the design session added to
                                        // `projects`; this branch's schema has only `githubRepo`, and
                                        // the provider is recoverable from the repo slug (see
                                        // `gitProviderOf` in ProjectsSection), so it is not sent.
                                        const id = await createProject.mutate({
                                            framework: framework.trim() || undefined,
                                            githubRepo: parsed,
                                            name: finalName,
                                            organizationId,
                                            slug: slugify(finalName),
                                        });
                                        onImported(id);
                                        onOpenChange(false);
                                    } catch (error_: unknown) {
                                        setError(error_ instanceof Error ? error_.message : "import failed");
                                    }
                                })();
                            }}
                        >
                            <Field htmlFor="import-repo" label="Repository URL">
                                <Input
                                    id="import-repo"
                                    onChange={(event) => {
                                        setRepo(event.target.value);
                                    }}
                                    placeholder={selected === "gitlab" ? "https://gitlab.com/owner/name" : "https://github.com/owner/name"}
                                    required
                                    value={repo}
                                />
                            </Field>
                            <Field htmlFor="import-name" label="Project name">
                                <Input
                                    id="import-name"
                                    onChange={(event) => {
                                        setName(event.target.value);
                                    }}
                                    placeholder={repoName || "my-app"}
                                    value={name}
                                />
                            </Field>
                            <Field htmlFor="import-framework" label="Framework">
                                <Input
                                    id="import-framework"
                                    onChange={(event) => {
                                        setFramework(event.target.value);
                                    }}
                                    placeholder="optional"
                                    value={framework}
                                />
                            </Field>
                            <Button className="justify-self-start" disabled={createProject.pending} type="submit">
                                {createProject.pending ? "Importing…" : "Import project"}
                            </Button>
                            <FormError message={error} />
                        </FieldForm>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
};
