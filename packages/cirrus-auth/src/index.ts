export { createAuth } from "./createAuth.js";
export { hashPassword, verifyPassword } from "./pbkdf2.js";
export { emailPassword } from "./providers/emailPassword.js";
export { github } from "./providers/github.js";
export { google } from "./providers/google.js";
export {
    buildAuthorizeRedirect,
    decodeIdTokenPayload,
    deriveCodeChallenge,
    exchangeCodeForUser,
    exchangeGithubCode,
    exchangeGoogleCode,
} from "./routes/oauth.js";
export type { OAuthProfile, OAuthProviderDescriptor } from "./routes/oauth.js";
export { createSession, getSession, revokeSession, findUserByEmail } from "./session.js";
export type {
    AuthEnv,
    AuthProviderConfig,
    AuthProviderContext,
    AuthSession,
    AuthState,
    AuthUser,
    CirrusAuth,
    CirrusAuthOptions,
    RouteHandler,
    RouteMap,
    SessionNamespaceLike,
} from "./types.js";

import { emailPassword } from "./providers/emailPassword.js";
import { github } from "./providers/github.js";
import { google } from "./providers/google.js";

/** Bundle of built-in providers, mirroring the API surface in the design doc. */
export const providers = { emailPassword, github, google };
