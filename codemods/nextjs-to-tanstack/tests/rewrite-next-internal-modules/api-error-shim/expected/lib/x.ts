// TODO: next/dist migration (R4dist): ApiError shim — align status codes / JSON body with your TanStack Start server routes — https://tanstack.com/start/latest/docs/framework/react/guide/server-routes
class ApiError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
  }
}
export function boom() {
  throw new ApiError(400, "bad");
}
