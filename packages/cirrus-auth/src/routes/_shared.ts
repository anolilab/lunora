export const jsonResponse = (status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...extraHeaders },
    });

export const jsonError = (status: number, code: string, message: string): Response =>
    jsonResponse(status, { error: { code, message } });

export const parseJsonBody = async (request: Request): Promise<Record<string, unknown> | null> =>
    request
        .clone()
        .json<Record<string, unknown>>()
        .catch(() => null);
