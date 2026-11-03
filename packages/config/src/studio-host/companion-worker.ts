/**
 * Request handler for the companion Worker that serves the advisor procedure
 * list to the app's Worker. A hosted Studio has no dev host, so the list it needs
 * (`_generated/advisor-procedures.json`) is embedded at deploy time and served
 * here. The companion holds no admin check: its address is private
 * (`workers_dev` off, no route), and the app's Worker checks the admin token
 * before it forwards a request.
 *
 * Transport-free: the caller passes the Request and the embedded document.
 */

/** Path the hosted Studio fetches. Matches the dev host's route. */
const ADVISOR_PROCEDURES_PATH = "/__lunora/advisor-procedures";

interface CompanionWorkerOptions {
    /** The generated `advisor-procedures.json` contents, embedded at deploy time. */
    readonly procedures: string;
}

/** Builds the fetch handler. */
const createCompanionHandler =
    ({ procedures }: CompanionWorkerOptions): ((request: Request) => Response) =>
    (request: Request): Response => {
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
