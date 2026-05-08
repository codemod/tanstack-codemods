import { describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual };
});

describe("proxy", () => {
  it("next", () => {
    const res = NextResponse.next();
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});
