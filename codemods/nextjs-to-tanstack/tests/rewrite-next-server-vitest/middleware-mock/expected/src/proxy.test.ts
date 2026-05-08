import { describe, expect, it, vi } from "vitest";

// TODO: next/server Vitest shim (R4h-test): Replace with `Request`/`Response` when tests no longer mimic Next middleware — https://tanstack.com/start/latest/docs/framework/react/guide/server-routes
type NextResponseInit = ResponseInit & { request?: { headers?: Headers } };

function __nextResponseJson(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

const NextResponse = Object.assign(
  function NextResponse(body?: BodyInit | null, init?: ResponseInit): Response {
    return new Response(body, init);
  },
  {
    json: __nextResponseJson,
    next: (init?: NextResponseInit) =>
      new Response(null, {
        status: 200,
        ...init,
        headers: {
          "x-middleware-next": "1",
          ...Object.fromEntries(new Headers(init?.headers)),
        },
      }),
    rewrite: (url: URL | string, init?: ResponseInit) => {
      const rewriteUrl = typeof url === "string" ? new URL(url, "http://localhost") : url;
      return new Response(null, {
        status: 200,
        ...init,
        headers: {
          "x-middleware-rewrite": rewriteUrl.toString(),
          ...Object.fromEntries(new Headers(init?.headers)),
        },
      });
    },
    redirect: (url: URL | string, statusOrInit?: number | ResponseInit) => {
      const redirectUrl = typeof url === "string" ? new URL(url, "http://localhost") : url;
      const status =
        typeof statusOrInit === "number"
          ? statusOrInit
          : (typeof statusOrInit === "object" && statusOrInit && "status" in statusOrInit
              ? (statusOrInit as ResponseInit).status
              : undefined) ?? 307;
      const baseInit =
        typeof statusOrInit === "object" && statusOrInit !== null && typeof statusOrInit !== "number"
          ? statusOrInit
          : {};
      const headers = new Headers((baseInit as ResponseInit).headers);
      headers.set("location", redirectUrl.toString());
      return new Response(null, { ...baseInit, status, headers });
    },
  },
);

class NextRequest extends Request {
  private readonly __cookieMap = new Map<string, string>();
  get nextUrl(): URL {
    return new URL(this.url);
  }
  cookies = {
    get: (name: string) => {
      const value = this.__cookieMap.get(name);
      return value !== undefined ? { name, value } : undefined;
    },
    set: (name: string, value: string) => {
      this.__cookieMap.set(name, value);
    },
  };
}

describe("proxy", () => {
  it("next", () => {
    const res = NextResponse.next();
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});
