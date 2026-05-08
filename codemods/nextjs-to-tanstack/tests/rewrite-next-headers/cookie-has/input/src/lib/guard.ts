import { cookies } from "next/headers";

export async function hasSess() {
  return (await cookies()).has("session");
}
