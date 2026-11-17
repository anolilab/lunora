import { resolve } from "node:path";

/**
 * The project a command works on: the `--root` directory, resolved against the working directory, or the working directory itself. The
 * Vite or Rspack plugin's explicit root must name the same directory, or the plugin cannot tell that it builds this run's worker.
 */
const projectRootFor = (workingDirectory: string, root: string | undefined): string =>
    root === undefined ? workingDirectory : resolve(workingDirectory, root);

export default projectRootFor;
