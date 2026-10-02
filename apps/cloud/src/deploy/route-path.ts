/**
 * Path patterns for the control-plane router: `/v1/boxes/releases/:deploymentId`.
 *
 * The router matches exact paths first; a route whose path holds a `:name`
 * segment is tried after, against this. A parameter matches one non-empty path
 * segment of `[A-Za-z0-9_-]` — the protocol's id alphabet — so a parameter can
 * never smuggle a `/`, a `.` or an encoded byte into the handler.
 */

const PARAMETER_SEGMENT = /^:(?<name>\w+)$/u;

const ID_SEGMENT = /^[\w-]{1,128}$/u;

/** Whether `path` is a pattern rather than an exact path. */
export const isRoutePattern = (path: string): boolean => path.split("/").some((segment) => PARAMETER_SEGMENT.test(segment));

/** Match `pathname` against `pattern`: its parameters by name, or `null` when it does not match. */
export const matchRoutePath = (pattern: string, pathname: string): null | Record<string, string> => {
    const expected = pattern.split("/");
    const actual = pathname.split("/");

    if (expected.length !== actual.length) {
        return null;
    }

    const parameters: Record<string, string> = {};

    for (const [index, segment] of expected.entries()) {
        const value = actual[index] ?? "";
        const name = PARAMETER_SEGMENT.exec(segment)?.groups?.["name"];

        if (name === undefined) {
            if (segment !== value) {
                return null;
            }
        } else if (ID_SEGMENT.test(value)) {
            parameters[name] = value;
        } else {
            return null;
        }
    }

    return parameters;
};
