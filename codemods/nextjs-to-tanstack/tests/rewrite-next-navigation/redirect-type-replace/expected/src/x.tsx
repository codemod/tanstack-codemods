
// TODO: next/navigation migration (R4g): use `throw redirect()` in loaders / beforeLoad — client nav: `useNavigate()` — https://tanstack.com/router/latest/docs/framework/react/guide/navigation
import { redirect } from "@tanstack/react-router";


export function guard() {
  throw redirect({ to: "/wish?error=invalid-thread-id", replace: true });
}
