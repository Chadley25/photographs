# Photographs

Photographs by Bradley Chavis, free for personal, non-commercial use.

A static gallery with no build step and no dependencies — one `index.html`
that reads its contents from `photos.json` at load time.

```
index.html           the gallery
photos.json          the manifest: thumb/full paths and dimensions
photos/              full-size images
photos/thumb/        ~900px web copies used in the grid
LICENSE              MIT, covers the site code
LICENSE-photos.txt   CC BY-NC 4.0, covers the photographs
```

## How it works

- **Justified rows.** Photos are packed greedily into rows, then each row's
  height is scaled so its photos exactly span the container at their true
  aspect ratios. Dimensions come from `photos.json`, so the layout settles
  before a single image has finished loading.
- **Density switch** — Large / Medium / Small, remembered per browser.
- **Viewer** — click any photo for a full-screen view with keyboard
  navigation (`←` `→` `Esc`).
- **Download gate** — the first download in a browser shows the CC BY-NC 4.0
  terms; the acknowledgement is kept in `localStorage` and a cookie.

### `photos.json`

```json
{
  "photos": [
    { "thumb": "photos/thumb/<name>.jpg",
      "full":  "photos/<name>.jpg",
      "w": 5184, "h": 3456,
      "location": "" }
  ]
}
```

`w`/`h` are the **full** image's pixel dimensions and drive the row layout.
`location` is an optional caption shown in the viewer. An empty `photos`
array renders a tidy "nothing here yet" state rather than a broken grid.

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
