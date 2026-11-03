/**
 * Request handler for the companion Worker that serves the advisor procedure
 * list to a hosted Studio. A hosted Studio has no dev host, so the list it needs
 * (`_generated/advisor-procedures.json`) is embedded at deploy time and served
 * here, gated on the admin token so the list is not public.
 *
 * Transport-free: the caller passes the Request and the embedded document.
 */
import { constantTimeEqual } from "../../../../shared/constant-time-equal";

/** Path the hosted Studio fetches. Matches the dev host's route. */
const ADVISOR_PROCEDURES_PATH = "/__lunora/advisor-procedures";

interface CompanionWorkerOptions {
    /** The admin token every request must present as `Authorization: Bearer <token>`. */
    readonly adminToken: string;
    /** The generated `advisor-procedures.json` contents, embedded at deploy time. */
    readonly procedures: string;
}

const bearer = (request: Request): string | undefined => {
    const header = request.headers.get("Authorization");

    return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
};

/**
 * Builds the fetch handler. A missing or wrong token answers 401 before the path
 * is read, so the route cannot be probed without the token.
 */
const createCompanionHandler = ({ adminToken, procedures }: CompanionWorkerOptions): ((request: Request) => Response) => (request: Request): Response => {
        const presented = bearer(request);

        if (presented === undefined || !constantTimeEqual(presented, adminToken)) {
            return Response.json({ error: "unauthorized" }, { status: 401 });
        }

        if (new URL(request.url).pathname !== ADVISOR_PROCEDURES_PATH) {
            return Response.json({ error: "not found" }, { status: 404 });
        }

        if (request.method !== "GET") {
            return Response.json({ error: "GET only" }, { status: 405 });
        }

        return new Response(procedures, { headers: { "Content-Type": "application/json" }, status: 200 });
    };

export { ADVISOR_PROCEDURES_PATH, createCompanionHandler };
export type { CompanionWorkerOptions };
