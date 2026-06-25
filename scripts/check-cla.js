/**
 * Verifies that a pull request description contains the required Contributor
 * License Agreement (CLA) confirmation text.
 *
 * The check is skipped for:
 *   - members of the GitHub organization that owns the repo (employees/maintainers)
 *   - automated PRs opened by dependabot / renovate (filtered in the workflow)
 *
 * Reads the following environment variables (set by `.github/workflows/cla.yml`):
 *   - PR_DESCRIPTION  the pull request body
 *   - PR_AUTHOR       the pull request author's GitHub login
 *   - GITHUB_TOKEN    token used to query org membership (optional but recommended)
 *   - ORGANIZATION    the org login to check membership against (defaults to "anolilab")
 *
 * Exits 0 when the CLA requirement is satisfied (or skipped), 1 otherwise.
 */

const CLA_TEXT =
    "By submitting this pull request, I confirm that my contribution is made under the terms of the project's license and that you can use, modify, copy, and redistribute this contribution under those terms.";

const ORGANIZATION = process.env.ORGANIZATION || "anolilab";

/**
 * Returns true if the user is a public or private member of the organization,
 * false if they are definitively not a member, and null if membership could not
 * be determined (network/API error) — in which case the CLA check still runs.
 *
 * @param {string} username
 * @param {string | undefined} token
 * @returns {Promise<boolean | null>}
 */
async function isOrgMember(username, token) {
    const url = `https://api.github.com/orgs/${ORGANIZATION}/members/${encodeURIComponent(username)}`;
    const headers = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "lunora-cla-check",
    };

    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    try {
        const response = await fetch(url, { headers });

        // 204 No Content => member; 404 => not a member.
        if (response.status === 204) {
            return true;
        }

        if (response.status === 404) {
            return false;
        }

        console.warn(`⚠️  Warning: unexpected status ${response.status} checking org membership.`);

        return null;
    } catch (error) {
        console.warn(`⚠️  Warning: failed to check organization membership: ${error.message}`);

        return null;
    }
}

async function main() {
    const description = process.env.PR_DESCRIPTION;
    const author = process.env.PR_AUTHOR;
    const token = process.env.GITHUB_TOKEN;

    if (!author) {
        console.error("❌ Error: PR_AUTHOR environment variable not set.");
        process.exit(1);
    }

    const memberStatus = await isOrgMember(author, token);

    if (memberStatus === true) {
        console.log(`✅ Skipping CLA check: ${author} is a member of the ${ORGANIZATION} organization.`);
        process.exit(0);
    }

    if (memberStatus === null) {
        console.warn(`⚠️  Could not verify organization membership for ${author}. Proceeding with CLA check.`);
    }

    if (!description || !description.includes(CLA_TEXT)) {
        console.error(
            "❌ Pull request description does not include the required CLA confirmation.\n\n" +
                "Please add the following line to your PR description:\n\n" +
                `> ${CLA_TEXT}`,
        );
        process.exit(1);
    }

    console.log("✅ CLA confirmation found in PR description.");
}

main();
