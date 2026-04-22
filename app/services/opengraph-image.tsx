import { createSocialImage, imageContentType, ogImageSize } from "@/lib/social-images";

export const alt = "Our Services at Dazbeez";
export const size = ogImageSize;
export const contentType = imageContentType;

export default function OpenGraphImage() {
  return createSocialImage({
    eyebrow: "Dazbeez Services",
    title: "Our Services",
    subtitle: "AI · Automation · Data · Governance · Project Management",
    visual: "services",
    pills: ["Strategy", "Delivery", "Compliance"],
    size,
  });
}
