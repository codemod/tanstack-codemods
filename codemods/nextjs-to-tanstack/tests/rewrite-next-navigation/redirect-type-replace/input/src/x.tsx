import { redirect, RedirectType } from "next/navigation";

export function guard() {
  redirect("/wish?error=invalid-thread-id", RedirectType.replace);
}
