import { ApiError } from "next/dist/server/api-utils";

export function boom() {
  throw new ApiError(400, "bad");
}
