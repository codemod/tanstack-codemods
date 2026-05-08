import type { useRouter } from "next/navigation";

export const redirectToGithubInstallation = (
  router: ReturnType<typeof useRouter>,
  to: string,
) => {
  router.push(to);
  router.replace("/");
};
