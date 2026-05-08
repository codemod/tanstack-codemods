// TODO: next/dist migration (R4dist): `ReadonlyURLSearchParams` from next/navigation → local alias; narrow to route search types when possible
type ReadonlyURLSearchParams = URLSearchParams;
export function f(u: ReadonlyURLSearchParams) {
  return u.get("x");
}
