"use client";

import type { ErrorComponentProps } from "@tanstack/react-router";
import { rootRouteId, useMatch, useRouter } from "@tanstack/react-router";
import type { JSX } from "react";

import { Action } from "@/kit/action";
import { Shell } from "@/kit/layout";
import { ArticleHeader } from "@/kit/page-header";

/**
 * The page shown when a route throws.
 *
 * It uses the same header every other page uses rather than a bare stack trace
 * on a white background: an error is still a page of this site, and the router
 * renders this in place of whatever the reader asked for, so it should not look
 * like the app fell over.
 *
 * Nothing about the thrown error reaches the reader in production. A route
 * error can carry the text of an upstream response or a description of the
 * server's internals, and this boundary renders for whoever provoked it, so
 * production gets one fixed sentence. In dev both the message and the full
 * error go to the console, where the person who can act on them is already
 * looking.
 */

const isError = (value: unknown): value is Error => value instanceof Error;

/** What the reader is told when the real reason is not theirs to see. */
const PUBLIC_MESSAGE = "The page could not be rendered.";

const DefaultCatchBoundary = ({ error }: ErrorComponentProps): JSX.Element => {
    const router = useRouter();
    const isRoot = useMatch({
        select: (state) => state.id === rootRouteId,
        strict: false,
    });

    if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console -- dev only, and the only place a developer can see the stack
        console.error("Route error:", error);
    }

    const handleTryAgain = (): void => {
        router.invalidate().catch(() => {
            // Ignore: a failed invalidate lands back in this boundary anyway.
        });
    };

    const goBack = (): void => {
        router.history.back();
    };

    const message = import.meta.env.DEV && isError(error) ? error.message : PUBLIC_MESSAGE;

    return (
        <div className="relative overflow-x-clip bg-canvas" data-theme="dark">
            <ArticleHeader
                actions={
                    <>
                        <Action onClick={handleTryAgain} variant="primary">
                            Try again
                        </Action>
                        {isRoot ? <Action to="/">Home</Action> : <Action onClick={goBack}>Go back</Action>}
                    </>
                }
                breadcrumb={[{ label: "Lunora", to: "/" }, { label: "Error" }]}
                lead={message}
                meta="Something went wrong"
                title="This page didn’t load."
            />

            <Shell className="py-section-end">
                <p className="max-w-2xl text-body text-ink-muted">
                    Retrying re-runs the page’s loaders, which clears it when the cause was transient. If it keeps happening,{" "}
                    <a
                        className="text-accent underline underline-offset-4 hover:text-ink"
                        href="https://github.com/anolilab/lunora/issues"
                        rel="noopener noreferrer"
                        target="_blank"
                    >
                        open an issue
                    </a>{" "}
                    with the address you were on.
                </p>
            </Shell>
        </div>
    );
};

export default DefaultCatchBoundary;
