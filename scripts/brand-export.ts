// Renders the brand SVGs in brand/ to PNG and ICO, and copies the files the site serves into public/.
// Run `npm run brand:export` after changing an SVG. It needs Playwright's Chromium (`npx playwright install chromium`).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { chromium } from "@playwright/test"

const root = path.resolve(import.meta.dirname, "..")
const brand = path.join(root, "brand")
const png = path.join(brand, "png")

const EXPORTS: { svg: string; out: string; width: number; height: number }[] = [
  { svg: "favicon.svg", out: "favicon-16.png", width: 16, height: 16 },
  { svg: "favicon.svg", out: "favicon-32.png", width: 32, height: 32 },
  { svg: "favicon.svg", out: "favicon-48.png", width: 48, height: 48 },
  { svg: "app-icon.svg", out: "apple-touch-icon.png", width: 180, height: 180 },
  { svg: "app-icon.svg", out: "icon-192.png", width: 192, height: 192 },
  { svg: "app-icon.svg", out: "icon-512.png", width: 512, height: 512 },
  { svg: "mark.svg", out: "mark-512.png", width: 512, height: 512 },
  { svg: "lockup.svg", out: "lockup.png", width: 794, height: 96 },
  { svg: "lockup-plate.svg", out: "lockup-plate.png", width: 890, height: 192 },
  { svg: "og-image.svg", out: "og-image.png", width: 1200, height: 630 },
]

// brand/ path -> public/ path: what index.html and the web manifest link to.
const SERVED: [string, string][] = [
  ["favicon.svg", "favicon.svg"],
  ["favicon.ico", "favicon.ico"],
  ["png/apple-touch-icon.png", "apple-touch-icon.png"],
  ["png/icon-192.png", "icon-192.png"],
  ["png/icon-512.png", "icon-512.png"],
  ["png/og-image.png", "og-image.png"],
]

// An ICO file that holds PNG images, which every current browser reads.
function ico(images: Buffer[]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach((image, index) => {
    const width = image.readUInt32BE(16)
    const height = image.readUInt32BE(20)
    const entry = 6 + 16 * index
    header.writeUInt8(width >= 256 ? 0 : width, entry)
    header.writeUInt8(height >= 256 ? 0 : height, entry + 1)
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(image.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += image.length
  })
  return Buffer.concat([header, ...images])
}

async function main() {
  mkdirSync(png, { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage()
  for (const { svg, out, width, height } of EXPORTS) {
    const data = readFileSync(path.join(brand, svg)).toString("base64")
    await page.setViewportSize({ width, height })
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}img{display:block}</style>` +
        `<img width="${width}" height="${height}" src="data:image/svg+xml;base64,${data}">`,
    )
    await page.waitForFunction("document.images[0]?.complete")
    await page.screenshot({ path: path.join(png, out), omitBackground: true, clip: { x: 0, y: 0, width, height } })
  }
  await browser.close()

  const favicons = [16, 32, 48].map((size) => readFileSync(path.join(png, `favicon-${size}.png`)))
  writeFileSync(path.join(brand, "favicon.ico"), ico(favicons))
  for (const [from, to] of SERVED) copyFileSync(path.join(brand, from), path.join(root, "public", to))
  console.log(`Wrote ${EXPORTS.length} PNGs and favicon.ico to brand/, and ${SERVED.length} files to public/.`)
}

await main()
