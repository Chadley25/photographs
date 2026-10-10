# Photographs

Photographs by Bradley Chavis, free for personal, non-commercial use.

A static gallery with no build step and no dependencies — `index.html` and
`gallery.js`, reading their contents from `photos.json` at load time.

```
index.html           page and styles
gallery.js           banner, tag filters, grid, and the viewer
photos.json          the manifest: every size of every photo, plus tags
photos/              full-size images
photos/thumb/        400px-tall copies (grid)
photos/thumb2x/      800px-tall copies (grid on high-density screens; viewer)
photos/zoom/         16-megapixel copies of very large photos (zooming on phones)
LICENSE              MIT, covers the site code
LICENSE-photos.txt   CC BY-NC 4.0, covers the photographs
```

## How it works

- **Banner.** A slow carousel behind the title: every photo that is wider
  than it is tall takes a turn, in an order shuffled on each visit. Upright
  photos are left out, by shape alone, so nothing needs marking by hand.
  Photos wider than the banner pan across it; the rest zoom in gently. Each
  slide is scaled to size in a worker and drawn with WebGL (a plain canvas
  where that isn't available), which keeps slow motion smooth and cheap. It
  pauses whenever it is off screen or the tab is hidden.
- **Ambient colour.** The page takes a dark tint of the photograph in view.
- **Tags** — chips for every tag, with counts, in a bar that stays at the
  top. The active tag is in the URL (`?tag=example-national-park`), so a
  filtered view can be shared, and the viewer moves within it.
- **Justified rows.** Each row closes at whichever break lands nearest a
  target height, then is scaled so its photos span the container at their
  true aspect ratios; wide panoramas get a row to themselves. Dimensions
  come from `photos.json`, so the layout settles before any image loads.
- **Sharp at any size.** Each photo is published in several sizes, and the
  page fetches the smallest one that's sharp where it's shown.
- **Viewer** — the photo lifts out of the grid and settles back on close.
  Pinch, double-tap, scroll or double-click to zoom; drag to pan; swipe or
  use the strip of thumbnails to move between photos. Keyboard: `←` `→` `z`
  `+` `-` `0` `Esc`. Phones never load more than 20 megapixels; desktops
  load the original only when zoomed in far enough to need it.
- **Selecting several** — press and hold a photo to start selecting, then
  download the lot: separate files on a computer, one `.zip` on a phone.
- **Download gate** — the first download in a browser shows the CC BY-NC 4.0
  terms; the acknowledgement is kept in `localStorage` and a cookie.

### `photos.json`

```json
{
  "photos": [
    { "thumb": "photos/thumb/<name>.jpg",
      "full":  "photos/<name>.jpg",
      "w": 8160, "h": 6120,
      "location": "",
      "tags": ["Example National Park"],
      "renditions": [
        { "src": "photos/thumb/<name>.jpg",   "w": 533,  "h": 400 },
        { "src": "photos/thumb2x/<name>.jpg", "w": 1067, "h": 800 },
        { "src": "photos/zoom/<name>.jpg",    "w": 4619, "h": 3464 },
        { "src": "photos/<name>.jpg",         "w": 8160, "h": 6120 }
      ] }
  ]
}
```

`w`/`h` are the **full** image's pixel dimensions and drive the row layout.
`renditions` lists every size, smallest first, including the original; the
page picks from it by need. `tags` make the filter chips and the captions. `location` is an optional caption that takes
precedence over the tags. Entries without `renditions` or `tags` still work —
the page falls back to `thumb` and `full`. An empty `photos` array renders a
tidy "nothing here yet" state rather than a broken grid.

Adding a photo is a commit — nothing needs rebuilding.

## Local preview

`fetch()` will not read `photos.json` over `file://`, so serve the directory:

```bash
python3 -m http.server 8000
```

## Licensing

The site code is MIT (`LICENSE`). The photographs are **CC BY-NC 4.0**
(`LICENSE-photos.txt`) — share and adapt them for non-commercial purposes
with credit to Bradley Chavis. For commercial use, get in touch first.
