import { after } from "next/server";

export function run() {
  after(() => {
    console.log("later");
  });
}
