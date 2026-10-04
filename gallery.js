/* Photographs -- justified grid, place filters, and a zoomable viewer.
   No dependencies. Reads photos.json at load time. */
(function () {
  "use strict";

  // ---- Content (mirrors the design component's props) ----
  const CONTENT = {
    siteTitle: "Photographs",
    author: "Bradley Chavis",
    siteBlurb: "Taken mostly outdoors, mostly of things that held still long enough.",
    licenseNote: "Download anything here and use it for personal, non-commercial things: wallpapers, prints for your own wall, a school project. Credit Bradley Chavis where it's practical, and keep it non-commercial. For anything commercial, get in touch first.",
    downloadNote: "Free for personal, non-commercial use under CC BY-NC 4.0. Credit: Bradley Chavis."
  };

  const DENSITIES = [
    { key: "large",  label: "Large",  rh: 460, title: "Fewer, larger photos per row" },
    { key: "medium", label: "Medium", rh: 310, title: "Balanced" },
    { key: "small",  label: "Small",  rh: 200, title: "Many photos at once" }
  ];

  const GAP = 10;
  const COOKIE = "license_accepted";
  const COOKIE_VALUE = "ccbync4";
  const DENSITY_KEY = "photographs_density";
  const HINT_KEY = "photographs_viewer_hint";

  // Image-size policy.
  const TOUCH = window.matchMedia && matchMedia("(pointer: coarse)").matches;
  // Phones and tablets struggle to decode very large images (and some give up
  // entirely), so they never get more than this many pixels. Desktops may load
  // the original when zoomed far enough in to need it.
  const MAX_PIXELS = TOUCH ? 20e6 : 130e6;
  const GRID_MAX_H = 800;        // renditions this tall or less feed the grid
  const NARROW_MAX_AR = 3;       // narrow screens crop very wide panoramas in the grid
  const REDUCED_MOTION = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- State ----
  const state = {
    photos: [],      // normalised entries from photos.json
    visible: [],     // indexes into photos, in display order, after filtering
    tags: [],        // [{ name, slug, count }]
    filter: null,    // slug of the active tag, or null for everything
    density: "medium",
    width: 0,
    agreed: false,
    gateOpen: false,
    loaded: false    // photos.json has arrived (until then, show no empty state)
  };

  let cells = [];        // one persistent <a class="cell"> per photo
  let rowNodes = [];     // reusable row containers
  const grid = document.getElementById("grid");
  const emptyEl = document.getElementById("empty");
  const countEl = document.getElementById("count-label");
  const densityEl = document.getElementById("density");
  const filtersEl = document.getElementById("filters");
  let lastFocus = null;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const pad = (n) => String(n).padStart(2, "0");

  // ---- Photos ----
  // Newer manifests list several sizes of each photo under `renditions`;
  // older ones only have a 900px-wide `thumb` and the original. Either way,
  // everything below works from one ascending list of { src, w, h }.
  function normalize(p) {
    const full = p.full || p.file;
    const w = p.w || 0, h = p.h || 0;
    const ar = w && h ? w / h : 1.5;
    let r = Array.isArray(p.renditions)
      ? p.renditions.filter((x) => x && x.src && x.w > 0 && x.h > 0).map((x) => ({ src: x.src, w: x.w, h: x.h }))
      : [];
    // An old-format entry has nothing between its thumbnail and the original,
    // so the original stays allowed on phones, exactly as it always was.
    const legacy = !r.length;
    if (legacy && p.thumb) r.push({ src: p.thumb, w: 900, h: Math.round(900 / ar) });
    if (full && !r.some((x) => x.src === full)) r.push({ src: full, w: w || 4000, h: h || Math.round(4000 / ar), legacy: legacy });
    r.sort((a, b) => a.w - b.w);
    return {
      full: full,
      thumb: p.thumb || (r[0] && r[0].src) || full,
      w: w, h: h, ar: ar,
      renditions: r,
      location: p.location || "",
      tags: Array.isArray(p.tags) ? p.tags.filter((t) => typeof t === "string" && t.trim()) : []
    };
  }

  const captionFor = (p) => p.location || p.tags.join(" \u00b7 ");
  const altFor = (p) => (captionFor(p) ? "Photograph \u2014 " + captionFor(p) : "Photograph");

  // Smallest rendition at least `needW` pixels wide, within the pixel budget;
  // the largest allowed one when nothing is that wide.
  function pickRendition(p, needW) {
    const allowed = p.renditions.filter((r, i) => i === 0 || r.legacy || r.w * r.h <= MAX_PIXELS);
    for (const r of allowed) if (r.w >= needW * 0.92) return r;
    return allowed[allowed.length - 1];
  }

  // ---- License agreement memory ----
  function hasAgreed() {
    try { if (localStorage.getItem(COOKIE) === COOKIE_VALUE) return true; } catch (e) {}
    return document.cookie.split("; ").some((c) => c === COOKIE + "=" + COOKIE_VALUE);
  }

  function rememberAgreement() {
    try { localStorage.setItem(COOKIE, COOKIE_VALUE); } catch (e) {}
    try {
      document.cookie = COOKIE + "=" + COOKIE_VALUE + "; max-age=" + 60 * 60 * 24 * 365 + "; path=/; samesite=lax";
    } catch (e) {}
  }

  function triggerDownload(url) {
    const a = document.createElement("a");
    a.href = url;
    a.download = url.split("/").pop() || "photograph.jpg";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---- Static content ----
  function paintContent() {
    document.getElementById("site-title").textContent = CONTENT.siteTitle;
    document.getElementById("site-author").textContent = CONTENT.author;
    document.getElementById("site-blurb").textContent = CONTENT.siteBlurb;
    document.getElementById("license-note").textContent = CONTENT.licenseNote;
    document.getElementById("copyright").textContent = "\u00a9 " + new Date().getFullYear() + " " + CONTENT.author;
    document.title = CONTENT.siteTitle + " \u2014 " + CONTENT.author;
  }

  function paintCount() {
    const n = state.visible.length;
    if (!state.loaded) { countEl.textContent = ""; return; }
    countEl.textContent = state.photos.length === 0
      ? "No photographs yet"
      : n + (n === 1 ? " photograph" : " photographs");
  }

  // ---- Density switch ----
  function buildDensity() {
    DENSITIES.forEach((d) => {
      const b = el("button", null, d.label);
      b.type = "button";
      b.title = d.title;
      b.dataset.key = d.key;
      b.addEventListener("click", () => {
        if (state.density === d.key) return;
        state.density = d.key;
        try { localStorage.setItem(DENSITY_KEY, d.key); } catch (e) {}
        paintDensity();
        layout();
      });
      densityEl.appendChild(b);
    });
    paintDensity();
  }

  function paintDensity() {
    for (const b of densityEl.children) b.setAttribute("aria-pressed", String(b.dataset.key === state.density));
  }

  // ---- Place filters ----
  const slugify = (s) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  function buildFilters() {
    const counts = new Map();
    for (const p of state.photos) for (const t of p.tags) counts.set(t, (counts.get(t) || 0) + 1);
    state.tags = [...counts].map(([name, count]) => ({ name, count, slug: slugify(name) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    filtersEl.textContent = "";
    filtersEl.hidden = state.tags.length === 0;
    if (state.filter && !state.tags.some((t) => t.slug === state.filter)) state.filter = null;
    if (!state.tags.length) return;

    const chip = (slug, label, count) => {
      const b = el("button", "chip");
      b.type = "button";
      b.dataset.slug = slug || "";
      b.append(label, el("span", "chip-count", String(count)));
      b.addEventListener("click", () => setFilter(slug));
      filtersEl.appendChild(b);
    };
    chip(null, "All", state.photos.length);
    for (const t of state.tags) chip(t.slug, t.name, t.count);
    paintFilters();
  }

  function paintFilters() {
    for (const b of filtersEl.children) b.setAttribute("aria-pressed", String(b.dataset.slug === (state.filter || "")));
  }

  function setFilter(slug) {
    state.filter = slug || null;
    try {
      const u = new URL(location.href);
      if (state.filter) u.searchParams.set("tag", state.filter); else u.searchParams.delete("tag");
      history.replaceState(null, "", u);
    } catch (e) {}
    paintFilters();
    applyFilter();
  }

  function applyFilter() {
    const tag = state.filter && (state.tags.find((t) => t.slug === state.filter) || {}).name;
    state.visible = [];
    state.photos.forEach((p, i) => { if (!tag || p.tags.includes(tag)) state.visible.push(i); });
    paintCount();
    layout();
  }

  // ---- Grid ----
  function buildCells() {
    grid.textContent = "";
    rowNodes = [];
    cells = state.photos.map((p, idx) => {
      const a = el("a", "cell");
      a.href = p.full;
      const img = document.createElement("img");
      img.alt = altFor(p);
      img.loading = "lazy";
      img.decoding = "async";
      // Every size short enough for the grid; layout() sets `sizes` to the
      // cell's real width so the browser fetches the smallest sharp one --
      // which for a wide panorama is a much wider file than for a portrait.
      const fits = p.renditions.filter((r, i) => i === 0 || r.h <= GRID_MAX_H);
      if (fits.length) {
        img.sizes = "320px";
        img.srcset = fits.map((r) => r.src + " " + r.w + "w").join(", ");
      }
      img.src = p.thumb;
      a.appendChild(img);
      a.addEventListener("click", (e) => { e.preventDefault(); openViewer(idx); });
      a._ar = p.ar;
      a._img = img;
      return a;
    });
    emptyEl.hidden = !state.loaded || state.photos.length > 0;
    grid.hidden = state.loaded && state.photos.length === 0;
  }

  function targetHeight() {
    const d = DENSITIES.find((x) => x.key === state.density) || DENSITIES[1];
    const w = state.width;
    if (!w) return d.rh;
    if (w < 560) return Math.round(d.rh * 0.55);
    if (w < 900) return Math.round(d.rh * 0.78);
    return d.rh;
  }

  // On a phone, a 7:1 panorama sharing nothing but the screen width is a
  // sliver a few dozen pixels tall. Lay very wide images out as if they were
  // NARROW_MAX_AR and let object-fit crop the sides; the viewer shows it all.
  const layoutAr = (cell) => (state.width && state.width < 700 ? Math.min(cell._ar, NARROW_MAX_AR) : cell._ar);

  // Greedy justified-row packing: fill each row, then scale its height so the
  // row's photos exactly span the container at their aspect ratios.
  function buildRows(items) {
    const width = state.width;
    const target = targetHeight();
    if (!width) return [{ items, height: target }];

    const rows = [];
    let run = [], arSum = 0;
    const flush = (scale) => {
      if (!run.length) return;
      const avail = width - GAP * (run.length - 1);
      rows.push({ items: run, height: Math.round(scale ? avail / arSum : target) });
      run = []; arSum = 0;
    };
    for (const it of items) {
      run.push(it);
      arSum += layoutAr(it);
      if (arSum * target + GAP * (run.length - 1) >= width) flush(true);
    }
    flush(false);
    return rows;
  }

  function layout() {
    const shown = new Set(state.visible);
    cells.forEach((c, i) => { if (!shown.has(i) && c.parentNode) c.parentNode.removeChild(c); });
    const items = state.visible.map((i) => cells[i]);
    const rows = items.length ? buildRows(items) : [];

    // Reuse row containers so cells are never needlessly detached, which
    // keeps the fade-in from replaying and avoids image re-decodes.
    while (rowNodes.length < rows.length) {
      const r = el("div", "row");
      grid.appendChild(r);
      rowNodes.push(r);
    }
    while (rowNodes.length > rows.length) grid.removeChild(rowNodes.pop());

    rows.forEach((row, ri) => {
      const node = rowNodes[ri];
      row.items.forEach((cell, ci) => {
        const w = Math.round(row.height * layoutAr(cell));
        cell.style.width = w + "px";
        cell.style.height = row.height + "px";
        // The image is drawn 2.5% larger than its cell (see the hover CSS).
        const want = Math.ceil(Math.max(w, row.height * cell._ar) * 1.025) + "px";
        if (cell._img.sizes !== want) cell._img.sizes = want;
        if (node.children[ci] !== cell) node.insertBefore(cell, node.children[ci] || null);
      });
      while (node.children.length > row.items.length) node.removeChild(node.lastChild);
    });
  }

  function measure() {
    const w = Math.round(grid.getBoundingClientRect().width);
    if (w && w !== state.width) {
      state.width = w;
      layout();
    }
  }

  // ---- Viewer ----
  // One <img> in a clipped stage, positioned and zoomed with a transform.
  // Geometry is kept in stage pixels: the image's displayed top-left is
  // (V.x, V.y) and its size is (V.fw * V.s, V.fh * V.s), where fw x fh is
  // the "fit" size at zoom 1.
  let V = null;

  const photoAt = (pos) => state.photos[state.visible[pos]];
  const current = () => (V ? photoAt(V.pos) : null) || {};

  function openViewer(photoIdx) {
    if (!state.visible.length) return;
    lastFocus = document.activeElement;
    buildViewer();
    // Locking page scroll hides a desktop scrollbar; pad its width back so the
    // grid behind the viewer doesn't reflow (and jump) on open and close.
    const bar = window.innerWidth - document.documentElement.clientWidth;
    if (bar > 0) document.documentElement.style.paddingRight = bar + "px";
    document.documentElement.classList.add("viewer-open");
    show(Math.max(0, state.visible.indexOf(photoIdx)), 0);
    maybeHint();
  }

  function closeViewer() {
    if (!V) return;
    window.removeEventListener("resize", V.onResize);
    clearTimeout(V.upgradeTimer);
    clearTimeout(V.tapTimer);
    V.root.remove();
    V = null;
    document.documentElement.classList.remove("viewer-open");
    document.documentElement.style.paddingRight = "";
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function buildViewer() {
    if (V) return;
    const root = el("div", "viewer");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Photograph viewer");

    const stage = el("div", "viewer-stage");
    const img = el("img", "viewer-img");
    img.draggable = false;
    img.decoding = "async";
    stage.appendChild(img);

    const bar = el("div", "viewer-bar");
    const meta = el("div", "viewer-meta");
    const idxEl = el("span", "viewer-index");
    const capEl = el("span", "viewer-location");
    meta.append(idxEl, capEl);

    const actions = el("div", "viewer-actions");
    const button = (cls, label, fn) => {
      const b = el("button", cls, label);
      b.type = "button";
      b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    const prev = button("btn-dark", "Previous", () => go(-1));
    const next = button("btn-dark", "Next", () => go(1));
    const zoomBtn = button("btn-dark", "Zoom", () => toggleZoomAt(V.stageW / 2, V.stageH / 2));
    const dl = el("a", "btn-download", "Download full size");
    dl.setAttribute("download", "");
    dl.addEventListener("click", onDownload);
    const close = button("btn-close", "Close", closeViewer);
    actions.append(prev, next, zoomBtn, dl, close);
    bar.append(meta, actions);

    const note = el("p", "viewer-note", CONTENT.downloadNote);
    root.append(stage, bar, note);
    document.body.appendChild(root);

    V = {
      root, stage, img, idxEl, capEl, zoomBtn, dl, prev, next,
      pos: 0, token: 0, s: 1, x: 0, y: 0, fw: 1, fh: 1, baseX: 0, baseY: 0,
      fillS: 1, maxS: 4, stageW: 1, stageH: 1, left: 0, top: 0,
      loadedW: 0, loading: null, prefetched: [],
      pointers: new Map(), g: null, lastTap: null, tapTimer: 0, upgradeTimer: 0, animating: false
    };

    stage.addEventListener("pointerdown", onDown);
    stage.addEventListener("pointermove", onMove);
    stage.addEventListener("pointerup", onUp);
    stage.addEventListener("pointercancel", onUp);
    stage.addEventListener("wheel", onWheel, { passive: false });
    // Not `e.target === img`: the stage captures the pointer during a click,
    // so the browser reports the double-click on the stage itself.
    stage.addEventListener("dblclick", (e) => {
      if (overImage(e.clientX, e.clientY)) toggleZoomAt(e.clientX - V.left, e.clientY - V.top);
    });
    img.addEventListener("error", () => {
      // A rendition the manifest promised is missing: fall back to the original.
      const p = current();
      if (p.full && V.img.getAttribute("src") !== p.full) { V.img.src = p.full; V.loadedW = p.w; }
    });
    V.onResize = () => { if (V) { fitGeometry(); resetZoom(false); ensureSource(); } };
    window.addEventListener("resize", V.onResize);
    if (!TOUCH) close.focus();
  }

  // Fit the current photo inside the stage (minus breathing room) at zoom 1.
  function fitGeometry() {
    const p = current();
    const r = V.stage.getBoundingClientRect();
    V.left = r.left; V.top = r.top;
    V.stageW = r.width; V.stageH = r.height;
    const narrow = r.width <= 640;
    const pad = narrow ? { t: 20, r: 16, b: 8, l: 16 } : { t: 56, r: 72, b: 12, l: 72 };
    V.box = { x: pad.l, y: pad.t, w: Math.max(1, r.width - pad.l - pad.r), h: Math.max(1, r.height - pad.t - pad.b) };
    const ar = p.ar || 1.5;
    if (V.box.w / V.box.h > ar) { V.fh = V.box.h; V.fw = V.fh * ar; }
    else { V.fw = V.box.w; V.fh = V.fw / ar; }
    V.baseX = V.box.x + (V.box.w - V.fw) / 2;
    V.baseY = V.box.y + (V.box.h - V.fh) / 2;
    V.img.style.width = V.fw + "px";
    V.img.style.height = V.fh + "px";

    // "Fill" zoom: the screen filled edge to edge. For a panorama that means
    // full height, ready to pan along -- the useful double-tap for it.
    V.fillS = Math.max(V.box.w / V.fw, V.box.h / V.fh);
    // Let zoom go to roughly 2x the largest image we're allowed to load, so
    // there is always detail to find, and never less than the fill zoom.
    const top = pickRendition(p, Infinity);
    const native = top.w / (V.fw * (window.devicePixelRatio || 1));
    V.maxS = clamp(Math.max(2.5, native * 2, V.fillS * 1.5), 2.5, 60);
  }

  function overImage(x, y) {
    const r = V.img.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function clampAxis(pos, size, boxStart, boxSize, stageSize) {
    if (size <= boxSize) return boxStart + (boxSize - size) / 2;   // smaller than the frame: centre it
    if (size <= stageSize) return clamp(pos, 0, stageSize - size); // fits on screen: keep it on screen
    return clamp(pos, stageSize - size, 0);                        // bigger than screen: no gaps at the edges
  }

  function clampPos() {
    V.x = clampAxis(V.x, V.fw * V.s, V.box.x, V.box.w, V.stageW);
    V.y = clampAxis(V.y, V.fh * V.s, V.box.y, V.box.h, V.stageH);
  }

  function render(transition) {
    V.img.style.transition = transition && !REDUCED_MOTION ? transition : "none";
    V.img.style.transform = "translate3d(" + V.x + "px," + V.y + "px,0) scale(" + V.s + ")";
    const zoomed = V.s > 1.01;
    V.stage.classList.toggle("zoomed", zoomed);
    V.zoomBtn.textContent = zoomed ? "Fit" : "Zoom";
  }

  const EASE = "transform .24s cubic-bezier(.2,.8,.2,1)";

  function zoomTo(ns, px, py, animate) {
    ns = clamp(ns, 1, V.maxS);
    const u = (px - V.x) / V.s, v = (py - V.y) / V.s;  // image point under (px, py)
    V.s = ns;
    V.x = px - u * ns;
    V.y = py - v * ns;
    clampPos();
    render(animate ? EASE : null);
    scheduleUpgrade();
  }

  function resetZoom(animate) {
    V.s = 1; V.x = V.baseX; V.y = V.baseY;
    render(animate ? EASE : null);
  }

  function toggleZoomAt(px, py) {
    if (!V) return;
    if (V.s > 1.01) { resetZoom(true); return; }
    // Panoramas (and anything that leaves big bars) zoom to fill the screen;
    // photos shaped like the screen get a plain 2.5x.
    zoomTo(V.fillS >= 1.6 ? V.fillS : 2.5, px, py, true);
  }

  // ---- Progressive sources ----
  // Show whatever is already in hand at once (the grid thumbnail), then load
  // the smallest rendition that is sharp at the current zoom, and keep
  // upgrading as you zoom in. Nothing is ever downgraded.
  function scheduleUpgrade() {
    clearTimeout(V.upgradeTimer);
    V.upgradeTimer = setTimeout(ensureSource, 140);
  }

  function ensureSource() {
    if (!V) return;
    const p = current();
    const r = pickRendition(p, V.fw * V.s * (window.devicePixelRatio || 1));
    if (!r || r.w <= V.loadedW || V.loading === r.src) return;
    V.loading = r.src;
    V.stage.classList.add("busy");
    const token = V.token;
    const im = new Image();
    im.decoding = "async";
    im.src = r.src;
    const done = () => {
      if (!V || token !== V.token) return;
      V.loading = null;
      V.stage.classList.remove("busy");
      if (r.w > V.loadedW) { V.img.src = r.src; V.loadedW = r.w; }
      prefetchNeighbours();
      ensureSource();   // zoom may have moved on while this loaded
    };
    (im.decode ? im.decode() : new Promise((ok, no) => { im.onload = ok; im.onerror = no; }))
      .then(done, () => {
        if (!V || token !== V.token) return;
        V.loading = null;
        V.stage.classList.remove("busy");
      });
  }

  // What the viewer will want first for the photos either side, so a swipe
  // lands on an already-sharp image.
  function prefetchNeighbours() {
    const n = state.visible.length;
    if (n < 2) return;
    V.prefetched = [];
    for (const d of [1, -1]) {
      const p = photoAt((V.pos + d + n) % n);
      const fw = V.box.w / V.box.h > p.ar ? V.box.h * p.ar : V.box.w;
      const im = new Image();
      im.src = pickRendition(p, fw * (window.devicePixelRatio || 1)).src;
      V.prefetched.push(im);
    }
  }

  // The best-resolution copy of this photo already loaded in the grid, if any.
  function gridSource(p) {
    const idx = state.photos.indexOf(p);
    const img = cells[idx] && cells[idx]._img;
    const src = img && img.complete && img.naturalWidth ? img.currentSrc : "";
    if (!src) return null;
    const r = p.renditions.find((x) => src.endsWith(x.src));
    return r ? { src: src, w: r.w } : { src: src, w: img.naturalWidth };
  }

  function show(pos, dir) {
    const n = state.visible.length;
    V.pos = ((pos % n) + n) % n;
    V.token += 1;
    V.loading = null;
    V.stage.classList.remove("busy");
    const p = current();

    const ph = gridSource(p) || { src: p.renditions[0].src, w: p.renditions[0].w };
    V.img.src = ph.src;
    V.loadedW = ph.w;
    V.img.alt = altFor(p);

    fitGeometry();
    resetZoom(false);
    if (dir && !REDUCED_MOTION) {
      // Slide the new photo in from the side it was swiped towards.
      V.img.style.opacity = "0";
      V.x = V.baseX + dir * Math.min(V.stageW * 0.35, 220);
      render(null);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!V) return;
        V.img.style.opacity = "1";
        V.x = V.baseX;
        render("transform .22s cubic-bezier(.2,.8,.2,1), opacity .22s ease-out");
      }));
    } else {
      V.img.style.opacity = "1";
    }

    V.idxEl.textContent = pad(V.pos + 1) + " / " + pad(n);
    V.capEl.textContent = captionFor(p);
    V.dl.href = p.full || "#";
    V.prev.disabled = V.next.disabled = n < 2;
    ensureSource();
  }

  function go(dir) {
    if (!V || state.visible.length < 2 || V.animating) return;
    if (REDUCED_MOTION) { show(V.pos + dir, 0); return; }
    V.animating = true;
    V.img.style.opacity = "0";
    V.x = V.baseX - dir * Math.min(V.stageW * 0.35, 220);
    render("transform .16s ease-in, opacity .16s ease-in");
    setTimeout(() => {
      if (!V) return;
      V.animating = false;
      show(V.pos + dir, dir);
    }, 160);
  }

  // ---- Gestures ----
  // One finger: pan when zoomed in; otherwise swipe sideways for the next or
  // previous photo, or down to close. Two fingers: pinch to zoom. Double-tap
  // (double-click with a mouse) toggles between fit and zoomed.
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function onDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.pointerType === "mouse") e.preventDefault();
    // Keep receiving moves when a finger or cursor leaves the stage. Never let
    // a capture failure (e.g. a pointer already gone) abort the gesture.
    try { V.stage.setPointerCapture(e.pointerId); } catch (err) {}
    V.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...V.pointers.values()];
    if (pts.length === 1) {
      V.g = {
        mode: V.s > 1.01 ? "pan" : "swipe", sx: e.clientX, sy: e.clientY,
        x0: V.x, y0: V.y, t0: performance.now(), moved: false, axis: null,
        onImage: overImage(e.clientX, e.clientY)
      };
    } else if (pts.length === 2) {
      clearTimeout(V.tapTimer);
      const [a, b] = pts;
      V.g = { mode: "pinch", d0: Math.max(dist(a, b), 1), s0: V.s,
              mx: (a.x + b.x) / 2 - V.left, my: (a.y + b.y) / 2 - V.top, x0: V.x, y0: V.y, moved: true };
      V.root.style.background = "";
    }
  }

  function onMove(e) {
    if (!V || !V.pointers.has(e.pointerId)) return;
    V.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = V.g;
    if (!g) return;
    const pts = [...V.pointers.values()];

    if (g.mode === "pinch" && pts.length >= 2) {
      const [a, b] = pts;
      const ns = clamp(g.s0 * dist(a, b) / g.d0, 1, V.maxS);
      const mx = (a.x + b.x) / 2 - V.left, my = (a.y + b.y) / 2 - V.top;
      // Keep the image point that started under the fingers under them.
      const u = (g.mx - g.x0) / g.s0, v = (g.my - g.y0) / g.s0;
      V.s = ns; V.x = mx - u * ns; V.y = my - v * ns;
      clampPos();
      render(null);
      return;
    }

    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    if (g.mode === "pan") {
      if (Math.abs(dx) + Math.abs(dy) > 4) { g.moved = true; V.stage.classList.add("dragging"); }
      V.x = g.x0 + dx; V.y = g.y0 + dy;
      clampPos();
      render(null);
    } else if (g.mode === "swipe") {
      if (!g.axis && Math.abs(dx) + Math.abs(dy) > 8) g.axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
      if (!g.axis) return;
      g.moved = true;
      if (g.axis === "x") {
        V.x = V.baseX + dx;
        render(null);
      } else if (e.pointerType !== "mouse") {
        const down = Math.max(0, dy);
        V.y = V.baseY + down;
        V.root.style.background = "rgba(18,17,15," + clamp(1 - down / 500, 0.35, 1) + ")";
        render(null);
      }
    }
  }

  function onUp(e) {
    if (!V || !V.pointers.has(e.pointerId)) return;
    V.pointers.delete(e.pointerId);
    const g = V.g;
    if (!g) return;
    V.stage.classList.remove("dragging");

    if (g.mode === "pinch") {
      if (V.pointers.size === 1) {
        // Lifting one finger of a pinch carries on as a pan.
        const p = [...V.pointers.values()][0];
        V.g = { mode: V.s > 1.01 ? "pan" : "none", sx: p.x, sy: p.y, x0: V.x, y0: V.y, moved: true };
      } else {
        V.g = null;
      }
      if (V.s < 1.03) resetZoom(true); else scheduleUpgrade();
      return;
    }
    if (V.pointers.size) return;
    V.g = null;

    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    const dt = Math.max(performance.now() - g.t0, 1);
    if (g.mode === "swipe" && g.axis === "x") {
      const flick = Math.abs(dx / dt) > 0.45;
      if (state.visible.length > 1 && (Math.abs(dx) > Math.min(120, V.stageW * 0.18) || flick)) go(dx < 0 ? 1 : -1);
      else resetZoom(true);
      return;
    }
    if (g.mode === "swipe" && g.axis === "y") {
      if (dy > 110) { closeViewer(); return; }
      V.root.style.background = "";
      resetZoom(true);
      return;
    }
    if (g.mode === "pan") scheduleUpgrade();
    if (!g.moved && e.type === "pointerup") handleTap(e, g);
  }

  function handleTap(e, g) {
    if (e.pointerType === "mouse") {
      // Double-click is its own event; a single click off the photo closes.
      if (!g.onImage && V.s <= 1.01) closeViewer();
      return;
    }
    const now = performance.now();
    const t = V.lastTap;
    if (t && now - t.t < 320 && Math.hypot(e.clientX - t.x, e.clientY - t.y) < 32) {
      V.lastTap = null;
      clearTimeout(V.tapTimer);
      toggleZoomAt(e.clientX - V.left, e.clientY - V.top);
      return;
    }
    V.lastTap = { t: now, x: e.clientX, y: e.clientY };
    if (!g.onImage && V.s <= 1.01) {
      // Wait out the double-tap window before treating it as "close".
      clearTimeout(V.tapTimer);
      V.tapTimer = setTimeout(() => { if (V && V.lastTap) closeViewer(); }, 330);
    }
  }

  function onWheel(e) {
    e.preventDefault();
    const px = e.clientX - V.left, py = e.clientY - V.top;
    // Trackpad pinch arrives as ctrl+wheel; a trackpad two-finger scroll
    // (small pixel deltas, or any sideways motion) pans once zoomed in;
    // a mouse wheel zooms.
    const trackpadScroll = !e.ctrlKey && (Math.abs(e.deltaX) > 0 || (e.deltaMode === 0 && Math.abs(e.deltaY) < 40));
    if (trackpadScroll && V.s > 1.01) {
      V.x -= e.deltaX; V.y -= e.deltaY;
      clampPos();
      render(null);
      scheduleUpgrade();
      return;
    }
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    const k = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0018));
    if (V.s * k < 1.01) { resetZoom(false); return; }
    zoomTo(V.s * k, px, py, false);
  }

  function maybeHint() {
    if (!TOUCH) return;
    try { if (localStorage.getItem(HINT_KEY)) return; localStorage.setItem(HINT_KEY, "1"); } catch (e) { return; }
    const h = el("div", "viewer-hint", "Swipe for more \u00b7 pinch or double-tap to zoom");
    V.stage.appendChild(h);
    setTimeout(() => { h.style.opacity = "0"; }, 2600);
    setTimeout(() => h.remove(), 3400);
  }

  function onDownload(e) {
    e.stopPropagation();
    if (state.agreed) return; // let the native download proceed
    e.preventDefault();
    openGate();
  }

  // ---- License gate ----
  let gate = null;

  function openGate() {
    if (gate) return;
    state.gateOpen = true;

    gate = el("div", "gate-backdrop");
    gate.addEventListener("click", closeGate);

    const box = el("div", "gate");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Before you download");
    box.addEventListener("click", (e) => e.stopPropagation());

    box.appendChild(el("h2", null, "Before you download"));
    const p1 = el("p");
    const link = el("a", "cc", "CC BY-NC 4.0");
    link.href = "https://creativecommons.org/licenses/by-nc/4.0/";
    link.target = "_blank";
    link.rel = "license noopener";
    p1.append("These photographs are licensed under ", link,
      ". You may share and adapt them for any non-commercial purpose, as long as you credit " +
      CONTENT.author + " and note any changes you made.");
    box.appendChild(p1);
    box.appendChild(el("p", "last", "Commercial use is not permitted without permission."));

    const actions = el("div", "gate-actions");
    const agree = el("button", "btn-solid", "I agree \u2014 download");
    agree.type = "button";
    agree.addEventListener("click", (e) => {
      e.stopPropagation();
      rememberAgreement();
      const url = current().full;
      state.agreed = true;
      closeGate();
      if (url) triggerDownload(url);
    });
    const cancel = el("button", "btn-quiet", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", (e) => { e.stopPropagation(); closeGate(); });
    actions.append(agree, cancel, el("span", "gate-note", "Asked once per browser"));
    box.appendChild(actions);

    gate.appendChild(box);
    document.body.appendChild(gate);
    agree.focus();
  }

  function closeGate() {
    state.gateOpen = false;
    if (gate) { gate.remove(); gate = null; }
  }

  // ---- Keyboard ----
  function onKey(e) {
    if (state.gateOpen) {
      if (e.key === "Escape") closeGate();
      return;
    }
    if (!V) return;
    if (e.key === "Escape") closeViewer();
    else if (e.key === "ArrowRight") go(1);
    else if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "+" || e.key === "=") zoomTo(V.s * 1.5, V.stageW / 2, V.stageH / 2, true);
    else if (e.key === "-" || e.key === "_") { if (V.s / 1.5 < 1.01) resetZoom(true); else zoomTo(V.s / 1.5, V.stageW / 2, V.stageH / 2, true); }
    else if (e.key === "0") resetZoom(true);
  }

  // ---- Boot ----
  function init() {
    if (hasAgreed()) state.agreed = true;
    try {
      const saved = localStorage.getItem(DENSITY_KEY);
      if (saved && DENSITIES.some((d) => d.key === saved)) state.density = saved;
    } catch (e) {}
    try { state.filter = new URL(location.href).searchParams.get("tag") || null; } catch (e) {}

    paintContent();
    buildDensity();
    paintCount();
    buildCells();

    // Measure on the next frame: re-laying out from inside the observer's own
    // callback is what triggers "ResizeObserver loop" warnings.
    if (window.ResizeObserver) new ResizeObserver(() => requestAnimationFrame(measure)).observe(grid);
    else window.addEventListener("resize", measure);
    measure();
    window.addEventListener("keydown", onKey);

    fetch("photos.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const list = d && Array.isArray(d.photos) ? d.photos : [];
        state.photos = list.map(normalize).filter((p) => p.full);
        state.loaded = true;
        buildCells();
        buildFilters();
        state.width = 0;
        applyFilter();
        measure();
      })
      .catch(() => { state.loaded = true; buildCells(); paintCount(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
