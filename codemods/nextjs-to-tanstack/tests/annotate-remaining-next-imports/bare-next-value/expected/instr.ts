// TODO: remaining `next` root import — value imports (e.g. `createServer`, `Instrumentation`) have no TanStack twin; port boots/server wiring manually; type-only imports should have been erased by R4j — https://tanstack.com/start/latest/docs/framework/react/migrate-from-next-js
import { type Instrumentation } from "next";

export const register: Instrumentation = async () => {};
