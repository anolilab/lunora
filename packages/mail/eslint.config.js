import { cirrusEslintConfig } from "../../eslint.shared.js";

// @cirrus/mail ships TSX email templates, so it needs the JSX rule set.
export default cirrusEslintConfig({ react: true });
