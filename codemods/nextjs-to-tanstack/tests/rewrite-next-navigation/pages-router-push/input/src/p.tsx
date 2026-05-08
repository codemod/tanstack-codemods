import { useRouter } from "next/router";

export default function P() {
  const router = useRouter();
  return <button onClick={() => router.replace("/u")} />;
}
