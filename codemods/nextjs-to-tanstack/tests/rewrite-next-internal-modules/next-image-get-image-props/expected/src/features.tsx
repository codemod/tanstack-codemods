// TODO: next/dist migration (R4dist): next/image helper shim — verify responsive/srcSet behavior where `getImageProps` was used
type ImageProps = React.ImgHTMLAttributes<HTMLImageElement>;
// TODO: next/dist migration (R4dist): next/image helper shim — verify responsive/srcSet behavior where `getImageProps` was used
function getImageProps<T extends Record<string, unknown>>(input: T): { props: T } {
  return { props: input };
}
export function Features() {
  const imageProps = { alt: "x", width: 1, height: 1 } satisfies Partial<ImageProps>;
  const {
    props: { srcSet, ...rest },
  } = getImageProps({ src: "/x.png", alt: "x" });
  return <img {...imageProps} {...rest} srcSet={srcSet} />;
}
