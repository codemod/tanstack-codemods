import type { Thing } from "some-package";

/** Nested generics with multiple `};` lines must survive EOF-collapse (regression Cal platform/libraries). */
export type Q = Thing<{
  select: {
    id: true;
    members: {
      select: {
        role: true;
      };
    };
  };
}>;
