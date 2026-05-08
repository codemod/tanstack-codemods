// TODO: next/navigation type-only useRouter (R4g): switched ReturnType<typeof useRouter> to a local router-like type; prefer passing `useNavigate()` directly where possible
type NextNavigationRouterLike = {
  push: (to: string) => unknown;
  replace: (to: string) => unknown;
};


export const redirectToGithubInstallation = (
  router: NextNavigationRouterLike,
  to: string,
) => {
  router.push(to);
  router.replace("/");
};
