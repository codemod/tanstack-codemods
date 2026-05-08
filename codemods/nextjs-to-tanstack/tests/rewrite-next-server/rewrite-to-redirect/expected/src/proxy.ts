
// TODO: next/server migration (R4h): confirm `Request`/`Response` types match your runtime; port remaining `next/server` helpers — https://tanstack.com/start/latest/docs/framework/react/guide/server-routes

export default async function proxy(request: Request) {
  const notFoundUrl = new URL(request.url);
  notFoundUrl.pathname = "/404";
  return Response.redirect(notFoundUrl.toString(), 307);
}
