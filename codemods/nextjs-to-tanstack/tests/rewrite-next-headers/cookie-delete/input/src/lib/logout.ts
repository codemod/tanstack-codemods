import { cookies } from "next/headers";

export async function clearSession() {
  cookies().delete("session");
}
