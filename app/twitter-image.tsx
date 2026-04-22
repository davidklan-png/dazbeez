import { createSocialImage, imageContentType, twitterImageSize } from "@/lib/social-images";

export const alt = "Dazbeez AI, Automation and Data consulting in Japan";
export const size = twitterImageSize;
export const contentType = imageContentType;

export default function TwitterImage() {
  return createSocialImage({
    eyebrow: "Dazbeez",
    title: "Dazbeez",
    subtitle: "AI · Automation · Data — Japan",
    visual: "twitter",
    pills: ["Practical delivery", "Bee-themed systems"],
    size,
  });
}
