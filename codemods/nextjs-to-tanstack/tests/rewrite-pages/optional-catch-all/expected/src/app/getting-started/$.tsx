import { createFileRoute } from "@tanstack/react-router";

function OnboardingWizard() {
  return <main>wizard</main>;
}

export const Route = createFileRoute("/getting-started/$")({
  component: OnboardingWizard,
});
