import { NextRequest, NextResponse } from "next/server";

export default async function proxy(request: NextRequest) {
  const notFoundUrl = new URL(request.url);
  notFoundUrl.pathname = "/404";
  return NextResponse.rewrite(notFoundUrl);
}
