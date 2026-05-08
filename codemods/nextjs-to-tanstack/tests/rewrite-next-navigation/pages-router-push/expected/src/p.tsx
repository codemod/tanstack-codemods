
// TODO: next/navigation migration (R4g): use `throw redirect()` in loaders / beforeLoad — client nav: `useNavigate()` — https://tanstack.com/router/latest/docs/framework/react/guide/navigation
import { useNavigate } from "@tanstack/react-router";


export default function P() {
  const router = useNavigate();
  return <button onClick={() => router({ to: "/u", replace: true })} />;
}
