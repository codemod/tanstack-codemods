import dynamic from "next/dynamic";

const C = dynamic(() => import("./mod"), {
  loading: () => null,
  ssr: false,
});

export default C;
