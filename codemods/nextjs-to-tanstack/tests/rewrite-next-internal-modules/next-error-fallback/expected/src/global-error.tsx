"use client";

// TODO: next/dist migration (R4dist): `next/error` was replaced with a local fallback component; customize your global error UI
const NextError = ({ statusCode = 500 }: { statusCode?: number }) => (
  <div role="alert">Unexpected error</div>
);
export default function GlobalError() {
  return <NextError statusCode={0} />;
}
