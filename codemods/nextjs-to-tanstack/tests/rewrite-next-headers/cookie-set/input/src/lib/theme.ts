import { cookies } from "next/headers";

export async function pickDark() {
  (await cookies()).set("theme", "dark", { path: "/", maxAge: 60 * 60 * 24 * 365 });
}
