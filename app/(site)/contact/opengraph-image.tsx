import { createSocialImage, imageContentType, ogImageSize } from "@/lib/social-images";

export const alt = "Get in touch with Dazbeez";
export const size = ogImageSize;
export const contentType = imageContentType;

export default function OpenGraphImage() {
  return createSocialImage({
    eyebrow: "Contact Dazbeez",
    title: "Get in Touch",
    subtitle: "Start a conversation about your next project",
    visual: "contact",
    pills: ["Reply in 24h", "Scoped advice", "Japan + Hawaii"],
    size,
  });
}
