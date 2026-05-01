import { createServerFn } from "@tanstack/react-start";


export const create = createServerFn().handler(async () => {
  return true;
});

// TanStack migration note: server handler — add `.validator(...)` before `.handler(...)` when this accepts runtime inputs
export const remove = createServerFn().handler(async (id: string) => {
  return null;
});
