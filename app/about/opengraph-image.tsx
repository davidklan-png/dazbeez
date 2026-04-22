import { createSocialImage, imageContentType, ogImageSize } from "@/lib/social-images";

export const alt = "About Dazbeez";
export const size = ogImageSize;
export const contentType = imageContentType;

export default function OpenGraphImage() {
  return createSocialImage({
    eyebrow: "About Dazbeez",
    title: "About Dazbeez",
    subtitle: "AI, Automation & Data consulting in Japan",
    visual: "about",
    pills: ["Japan", "APPI-ready", "Fixed-scope"],
    size,
  });
}
