import { notFound } from "next/navigation";
import { services, isServiceSlug } from "@/lib/services";
import { serviceAccentColors } from "@/lib/service-assets";
import { createSocialImage, imageContentType, ogImageSize } from "@/lib/social-images";

export const alt = "Dazbeez service detail";
export const size = ogImageSize;
export const contentType = imageContentType;

export default async function OpenGraphImage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  if (!isServiceSlug(slug)) {
    notFound();
  }

  const service = services[slug];

  return createSocialImage({
    accent: serviceAccentColors[slug],
    eyebrow: "Dazbeez Service",
    title: service.title,
    subtitle: service.description,
    visual: slug,
    pills: service.related.map((relatedSlug) => services[relatedSlug].title),
    size,
  });
}
