# Brand

The mark, wordmark and icons of Safe State Check. The SVGs are the sources; everything in `png/` and `favicon.ico`
is rendered from them by `npm run brand:export`, which also copies the files the site serves into `public/`.

The look follows the Safe Design System (dark theme): black ground, Safe Green, DM Sans. It uses no Safe logo or
Safe icon: the mark is this project's own.

## The mark

Two lines across and two down, crossing like a `#` (a storage root is a hash), with a square on each crossing. It is the
frame-and-marker motif of the design system's slides, at the size of an icon.

| File               | What                                                                  | Use                               |
| ------------------ | --------------------------------------------------------------------- | --------------------------------- |
| `mark.svg`         | The mark alone, transparent, on a 24 grid.                            | Next to the name on dark grounds. |
| `favicon.svg`      | The mark on a black rounded tile, drawn on whole pixels of a 16 grid. | Browser tab icon (16, 32, 48 px). |
| `app-icon.svg`     | The mark on a full-bleed black square, inside the maskable zone.      | Home screen and app icons.        |
| `lockup.svg`       | Mark and "Safe State Check", text outlined, transparent.              | Dark grounds.                     |
| `lockup-plate.svg` | The lockup on a black plate.                                          | Light grounds, slides, documents. |
| `og-image.svg`     | 1200 × 630 social preview.                                            | Link previews (`og:image`).       |

`png/` holds `favicon-16.png`, `favicon-32.png`, `favicon-48.png`, `apple-touch-icon.png` (180 px), `icon-192.png`,
`icon-512.png`, `mark-512.png` (transparent), `lockup.png` and `lockup-plate.png` (2×) and `og-image.png`.
`favicon.ico` holds the 16, 32 and 48 px favicons.

## Colors

| Name       | Hex       | Where                            |
| ---------- | --------- | -------------------------------- |
| Safe Green | `#12FF80` | The four squares, links on dark. |
| Deep green | `#0D7F42` | The lines of the mark.           |
| Black      | `#000000` | Tiles, plates, the page ground.  |
| White      | `#FFFFFF` | The wordmark.                    |

Safe Green is 1.3:1 on white, so the mark never sits directly on a light ground: use the tile or the plate.

## Rules

- Keep clear space around the mark at least as wide as one of its squares.
- Resize in proportion only; never recolor, rotate or redraw it.
- The wordmark is DM Sans SemiBold (600). Its outlines were made from the font in `src/assets/fonts/`; to change the
  text, outline the new text from the same font.

## Fonts

DM Sans and Geist Mono are licensed under the SIL Open Font License 1.1; the license texts are in `src/assets/fonts/`.
