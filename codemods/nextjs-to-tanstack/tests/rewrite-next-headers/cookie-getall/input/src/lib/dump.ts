import { cookies } from "next/headers";

export async function allCookies() {
  return cookies().getAll();
}
