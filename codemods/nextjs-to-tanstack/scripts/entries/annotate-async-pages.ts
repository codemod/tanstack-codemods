/**
 * Async React Server Components with top-level awaits were previously flagged
 * with migration notes. Fully automated loader extraction remains unsafe across
 * arbitrary control-flow, so this step deliberately no-ops. Manual ports should
 * move data reads into `Route.loader` / `routeLoader` patterns from the TanStack
 * Start documentation when you refactor those routes.
 */

import type { Codemod } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";

const codemod: Codemod<TSX> = async () => null;

export default codemod;
