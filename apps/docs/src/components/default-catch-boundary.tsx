import type { ErrorComponentProps } from "@tanstack/react-router";
import { ErrorComponent, Link, rootRouteId, useMatch, useRouter } from "@tanstack/react-router";
import type { JSX, MouseEvent } from "react";
import { useCallback } from "react";

const handleGoBack = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    globalThis.history.back();
};

const DefaultCatchBoundary = ({ error }: ErrorComponentProps): JSX.Element => {
    const router = useRouter();
    const isRoot = useMatch({
        select: (state) => state.id === rootRouteId,
        strict: false,
    });

    // eslint-disable-next-line no-console
    console.error("DefaultCatchBoundary Error:", error);

    const handleTryAgain = useCallback((): void => {
        router.invalidate().catch(() => {
            // ignore invalidate errors — handled by the error boundary
        });
    }, [router]);

    return (
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-6 p-4">
            <ErrorComponent error={error} />
            <div className="flex flex-wrap items-center gap-2">
                <button className="rounded bg-gray-600 px-2 py-1 font-extrabold text-white uppercase dark:bg-gray-700" onClick={handleTryAgain} type="button">
                    Try Again
                </button>
                {isRoot ? (
                    <Link className="rounded bg-gray-600 px-2 py-1 font-extrabold text-white uppercase dark:bg-gray-700" to="/">
                        Home
                    </Link>
                ) : (
                    <Link className="rounded bg-gray-600 px-2 py-1 font-extrabold text-white uppercase dark:bg-gray-700" onClick={handleGoBack} to="/">
                        Go Back
                    </Link>
                )}
            </div>
        </div>
    );
};

export default DefaultCatchBoundary;
