import type { Prisma } from "@prisma/client";

/** Barrels / Prisma helpers under `app/` must not be brace-truncated. */
export type TeamQuery = Prisma.TeamGetPayload<{
  select: {
    id: true;
    members: {
      select: {
        role: true;
      };
    };
  };
}>;
