"use client";


// TODO: next/navigation migration (R4g): use `throw redirect()` in loaders / beforeLoad — client nav: `useNavigate()` — https://tanstack.com/router/latest/docs/framework/react/guide/navigation
import { useNavigate, useRouter } from "@tanstack/react-router";


export function X() {
  const navigate = useNavigate();
  const router = useRouter();
  navigate({ to: "/x" });
  router.invalidate();
  router.history.back();
}
