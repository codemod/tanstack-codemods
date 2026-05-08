import { useRouter } from "next/compat/router";

export default function C() {
  const router = useRouter();
  return <button type="button" onClick={() => router.replace("/x")} />;
}
