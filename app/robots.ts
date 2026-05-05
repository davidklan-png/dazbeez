import { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin/", "/receipts/", "/api/"],
    },
    host: "https://dazbeez.com",
    sitemap: "https://dazbeez.com/sitemap.xml",
  };
}
