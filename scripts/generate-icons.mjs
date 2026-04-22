import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

const outputDirectory = path.join(process.cwd(), "public", "icons");

const icons = [
  { filename: "icon-192.png", size: 192 },
  { filename: "icon-512.png", size: 512 },
  { filename: "apple-touch-icon.png", size: 180 },
];

const source = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none">
    <circle cx="50" cy="50" r="44" fill="#F59E0B"/>
    <text
      x="50"
      y="54"
      fill="#FFFFFF"
      font-family="Inter, Arial, sans-serif"
      font-size="54"
      font-weight="700"
      letter-spacing="-0.08em"
      text-anchor="middle"
    >D</text>
  </svg>
`);

await mkdir(outputDirectory, { recursive: true });

await Promise.all(
  icons.map(async ({ filename, size }) => {
    const destination = path.join(outputDirectory, filename);

    await sharp(source)
      .resize(size, size)
      .png()
      .toFile(destination);
  }),
);

console.log(`Generated ${icons.length} icons in ${outputDirectory}`);
