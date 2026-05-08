// TODO: next/dist migration (R4dist): next/server `after` shim — ensure background work semantics match your runtime
const after = (cb: () => unknown) => {
  void Promise.resolve().then(cb);
};
export function run() {
  after(() => {
    console.log("later");
  });
}
