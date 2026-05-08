"use client";

import NextError from "next/error";

export default function GlobalError() {
  return <NextError statusCode={0} />;
}
