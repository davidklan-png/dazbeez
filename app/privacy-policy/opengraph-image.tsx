import { createSocialImage, imageContentType, ogImageSize } from "@/lib/social-images";

export const alt = "Dazbeez privacy policy";
export const size = ogImageSize;
export const contentType = imageContentType;

export default function OpenGraphImage() {
  return createSocialImage({
    eyebrow: "Dazbeez Legal",
    title: "Privacy Policy",
    subtitle: "How Dazbeez handles data, inquiries, and retention under Japanese law",
    visual: "privacy",
    pills: ["APPI", "Retention", "Disclosure"],
    size,
  });
}
