# Photographs

Photographs by Bradley Chavis, free for personal, non-commercial use.

A static gallery with no build step and no dependencies — `index.html` and
`gallery.js`, reading their contents from `photos.json` at load time.

```
index.html           page and styles
gallery.js           grid, place filters, and the viewer
photos.json          the manifest: every size of every photo, plus place labels
photos/              full-size images
photos/thumb/        400px-tall copies (grid)
photos/thumb2x/      800px-tall copies (grid on high-density screens; viewer)
photos/zoom/         16-megapixel copies of very large photos (zooming on phones)
LICENSE              MIT, covers the site code
LICENSE-photos.txt   CC BY-NC 4.0, covers the photographs
```

## How it works

- **Justified rows.** Photos are packed greedily into rows, then each row's
  height is scaled so its photos exactly span the container at their true
  aspect ratios. Dimensions come from `photos.json`, so the layout settles
  before a single image has finished loading.
- **Sharp at any size.** Each photo is published in several sizes, and the
  page always fetches the smallest one that's sharp where it's shown — so a
  wide panorama gets a wide grid image instead of a stretched one. Grid copies
  are sized by height, because grid rows have a fixed height.
- **Density switch** — Large / Medium / Small, remembered per browser.
- **Place filters** — chips above the grid for every place label, with
  counts. The active filter is in the URL (`?tag=example-national-park`),
  so a filtered view can be shared, and the viewer moves within it.
- **Viewer** — opens instantly from the grid image, then sharpens. Pinch,
  double-tap, scroll or double-click to zoom; drag to pan. Double-tapping a
  panorama fills the screen's height so you can pan along it. Swipe sideways
  for the next photo and down to close. Keyboard: `←` `→` `+` `-` `0` `Esc`.
  Phones never load more than 20 megapixels; desktops load the original only
  when zoomed in far enough to need it.
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
page picks from it by need. `tags` are place labels: they make the filter
chips and the viewer's caption. `location` is an optional caption that takes
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
