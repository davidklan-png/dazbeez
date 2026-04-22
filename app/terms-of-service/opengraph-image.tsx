import { createSocialImage, imageContentType, ogImageSize } from "@/lib/social-images";

export const alt = "Dazbeez terms of service";
export const size = ogImageSize;
export const contentType = imageContentType;

export default function OpenGraphImage() {
  return createSocialImage({
    eyebrow: "Dazbeez Legal",
    title: "Terms of Service",
    subtitle: "Scope, delivery, and usage terms for the Dazbeez website and consulting services",
    visual: "terms",
    pills: ["Website use", "Consulting scope", "Legal terms"],
    size,
  });
}
