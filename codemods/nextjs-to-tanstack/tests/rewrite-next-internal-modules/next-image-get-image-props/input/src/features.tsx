import type { ImageProps } from "next/image";
import { getImageProps } from "next/image";

export function Features() {
  const imageProps = { alt: "x", width: 1, height: 1 } satisfies Partial<ImageProps>;
  const {
    props: { srcSet, ...rest },
  } = getImageProps({ src: "/x.png", alt: "x" });
  return <img {...imageProps} {...rest} srcSet={srcSet} />;
}
