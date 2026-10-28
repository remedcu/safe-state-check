import type { Plugin } from "vite"

// Adds a preload link for every font in the build, so the fonts load alongside the scripts instead of after the
// stylesheet is parsed. With `font-display: optional` in src/index.css, a font that is late is not used at all, so
// without this a first visit would rarely get DM Sans.
export function preloadFonts(): Plugin {
  return {
    name: "preload-fonts",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, { bundle }) {
        return Object.keys(bundle ?? {})
          .filter((file) => file.endsWith(".woff2"))
          .sort()
          .map((file) => ({
            tag: "link",
            attrs: { rel: "preload", href: `/${file}`, as: "font", type: "font/woff2", crossorigin: "" },
            injectTo: "head",
          }))
      },
    },
  }
}
