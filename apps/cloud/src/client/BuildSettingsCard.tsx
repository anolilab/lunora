import { useMutation } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { api } from "../../lunora/_generated/api.js";
import type { RecordedWorkspacePackages } from "../builds/paths";
import { normalizeRootDirectory, normalizeWatchPaths, watchPathsPreview } from "../builds/paths";
import type { ProjectRuntime } from "../project-runtime";
import { RuntimeField } from "./RuntimeField";
import { Field, FormError } from "./section-ui";
import type { OrgId, ProjectId } from "./types";

/** Stable default for `watchPaths`, so an unset prop is not a fresh array per render. */
const NO_WATCH_PATHS: string[] = [];

/** The form's problem, or `null` — the same rules the mutation enforces. */
const validate = (rootDirectory: string, watchPaths: string): null | string => {
    try {
        normalizeRootDirectory(rootDirectory);
        normalizeWatchPaths(watchPaths.split("\n"));

        return null;
    } catch (error) {
        return error instanceof Error ? error.message : "invalid build settings";
    }
};

/**
 * Build settings: what the project's code is (a Lunora app or a plain
 * Cloudflare Worker), and for a monorepo which directory of the repository is
 * this project and which paths a push has to touch before it rebuilds.
 */
export const BuildSettingsCard = ({
    organizationId,
    projectId,
    rootDirectory = "",
    runtime = "lunora",
    watchPaths = NO_WATCH_PATHS,
    workspacePackages,
}: {
    organizationId: OrgId;
    projectId: ProjectId;
    rootDirectory?: string;
    runtime?: ProjectRuntime;
    watchPaths?: string[];
    workspacePackages?: RecordedWorkspacePackages;
}): ReactElement => {
    const update = useMutation(api.projects.updateBuildSettings);
    const [kind, setKind] = useState(runtime);
    const [root, setRoot] = useState(rootDirectory);
    const [paths, setPaths] = useState(() => watchPaths.join("\n"));
    const [error, setError] = useState<null | string>(null);
    const problem = validate(root, paths);
    const preview =
        problem === null
            ? watchPathsPreview(normalizeRootDirectory(root) || undefined, normalizeWatchPaths(paths.split("\n")), workspacePackages)
            : { patterns: [] };

    const save = async (): Promise<void> => {
        setError(null);

        try {
            await update.mutate({ id: projectId, organizationId, rootDirectory: root, runtime: kind, watchPaths: paths.split("\n") });
        } catch (error_: unknown) {
            setError(error_ instanceof Error ? error_.message : "could not save build settings");
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>Build settings</CardTitle>
                <CardDescription>
                    For a monorepo: dependencies install at the nearest lockfile above the root directory, and{" "}
                    {kind === "worker" ? <code>wrangler deploy --dry-run</code> : <code>lunora build</code>} runs inside it. A runtime change applies from the
                    next push.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <form action={save} className="flex flex-col gap-3">
                    <RuntimeField id="build-runtime" onChange={setKind} value={kind} />
                    {kind === runtime ? null : (
                        <p className="text-warning text-xs" role="status">
                            A release of the other runtime is refused while one of this runtime is live: it would drop that Worker&apos;s Durable Object data.
                            Switch before the first deploy, or deploy the other runtime as a new project.
                        </p>
                    )}
                    <Field htmlFor="build-root-directory" label="Root directory">
                        <Input
                            aria-describedby="build-settings-problem"
                            aria-invalid={problem !== null}
                            id="build-root-directory"
                            onChange={(event) => {
                                setRoot(event.target.value);
                            }}
                            placeholder="repository root (e.g. apps/web)"
                            value={root}
                        />
                    </Field>
                    <Field htmlFor="build-watch-paths" label="Watch paths (one glob per line)">
                        {/* No shadcn textarea is vendored here; this matches `Input`'s styling. */}
                        <textarea
                            aria-describedby="build-settings-problem"
                            aria-invalid={problem !== null}
                            className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive placeholder:text-muted-foreground dark:bg-input/30 w-full rounded-md border bg-transparent px-2.5 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
                            id="build-watch-paths"
                            onChange={(event) => {
                                setPaths(event.target.value);
                            }}
                            placeholder={"defaults to everything under the root directory\ne.g. apps/web/**\npackages/ui/**"}
                            rows={4}
                            value={paths}
                        />
                    </Field>
                    {problem === null ? (
                        <p className="text-muted-foreground text-xs">
                            A push to the default branch (or a pull request) builds only when it changes one of:{" "}
                            <span className="font-mono">{preview.patterns.join(", ")}</span>. Pushes that cannot be checked (force pushes, new branches, very
                            large pushes) always build.{preview.note === undefined ? null : ` ${preview.note}`}
                        </p>
                    ) : (
                        <p className="text-destructive text-xs" id="build-settings-problem" role="alert">
                            {problem}
                        </p>
                    )}
                    <FormError message={error} />
                    <Button className="justify-self-start self-start" disabled={update.pending || problem !== null} type="submit">
                        {update.pending ? "Saving…" : "Save"}
                    </Button>
                </form>
            </CardContent>
        </Card>
    );
};
