/**
 * Session helper shared by the behaviour suites (`plugins.behaviour`,
 * `enterprise-auth.behaviour`, …), which drive real better-auth endpoints and so all
 * need to call them "as a signed-in user".
 */

/** The slice of an auth instance this helper touches — structural, so no `any` is needed. */
interface SignInCapableAuth {
    api: {
        signInEmail: (arguments_: { body: { email: string; password: string }; returnHeaders: true }) => Promise<{ headers: Headers }>;
    };
}

/**
 * Sign in and return a `Headers` carrying the session cookie, so subsequent
 * `auth.api.*` calls run as that user.
 */
const signInAndCookie = async (auth: SignInCapableAuth, email: string, password: string): Promise<Headers> => {
    const response = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
    const setCookie = response.headers.get("set-cookie");

    if (!setCookie) {
        throw new Error("sign-in did not return a set-cookie header");
    }

    const headers = new Headers();

    headers.set("cookie", setCookie);

    return headers;
};

export default signInAndCookie;
