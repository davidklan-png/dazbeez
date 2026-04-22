import { createSocialImage, imageContentType, ogImageSize } from "@/lib/social-images";

export const alt = "Dazbeez NFC quick access";
export const size = ogImageSize;
export const contentType = imageContentType;

export default function OpenGraphImage() {
  return createSocialImage({
    eyebrow: "Dazbeez NFC",
    title: "Dazbeez",
    subtitle: "dazbeez.com",
    visual: "nfc",
    pills: ["Tap", "Save", "Return"],
    size,
  });
}
