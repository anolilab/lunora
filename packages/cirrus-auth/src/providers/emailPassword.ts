import { meHandler } from "../routes/me.js";
import { signinHandler } from "../routes/signin.js";
import { signoutHandler } from "../routes/signout.js";
import { signupHandler } from "../routes/signup.js";
import type { AuthProviderConfig } from "../types.js";

export interface EmailPasswordOptions {
    allowSignup?: boolean;
}

/** Email + password provider. Adds the `/signup`, `/signin`, `/signout`, `/me` routes. */
export const emailPassword = (options: EmailPasswordOptions = {}): AuthProviderConfig => {
    const allowSignup = options.allowSignup ?? true;

    return {
        id: "email-password",
        routes: (context) => ({
            "POST /auth/signup": signupHandler(context, { allowSignup }),
            "POST /auth/signin": signinHandler(context),
            "POST /auth/signout": signoutHandler(context),
            "GET /auth/me": meHandler(context),
        }),
    };
};
