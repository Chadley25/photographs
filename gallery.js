/* Photographs -- banner, tag filters, justified grid, and a zoomable viewer.
   No dependencies. Reads photos.json at load time. */
(function () {
  "use strict";

  // ---- Content ----
  const CONTENT = {
    siteTitle: "Photographs",
    author: "Bradley Chavis",
    siteBlurb: "Taken mostly outdoors, mostly of things that held still long enough.",
    licenseNote: "Download anything here and use it for personal, non-commercial things: wallpapers, prints for your own wall, a school project. Credit Bradley Chavis where it's practical, and keep it non-commercial. For anything commercial, get in touch first.",
    downloadNote: "Free for personal, non-commercial use under CC BY-NC 4.0. Credit: Bradley Chavis."
  };

  const COOKIE = "license_accepted";
  const COOKIE_VALUE = "ccbync4";

  const TOUCH = window.matchMedia && matchMedia("(pointer: coarse)").matches;
  const REDUCED = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  // Phones and tablets struggle to decode very large images (and some give up
  // entirely), so they never get more than this many pixels. Desktops may load
  // the original when zoomed far enough in to need it.
  const MAX_PIXELS = TOUCH ? 20e6 : 130e6;
  const GRID_MAX_H = 800;          // renditions this tall or less are "small"
  // rise: how far photos travel as they appear; kb: how far a banner photo
  // zooms; pan: whether wide banner photos drift sideways.
  const MOTION = REDUCED ? { rise: 0, kb: 1, pan: false } : { rise: 12, kb: 1.035, pan: true };
  const HERO_SECONDS = 7;
  const HERO_FADE = 1400;          // ms
  const NEUTRAL = [30, 6];         // hue, saturation of the untinted page

  // ---- State ----
  const S = {
    photos: [], loaded: false, tag: null,
    open: false, i: 0, phase: "idle", from: null, dir: 1,
    zoom: { z: 1, ox: 0, oy: 0 }, zAnim: false,
    width: 0, vw: 1280, vh: 800,
    active: null, colors: {}, sel: new Set(),
    agreed: false, gateOpen: false
  };

  const $ = (id) => document.getElementById(id);
  const tintEl = $("tint"), heroEl = $("hero"), heroFill = $("hero-fill");
  let heroCanvas = $("hero-canvas");
  const heroIndex = $("hero-index"), heroCaption = $("hero-caption");
  const marker = $("marker"), bar = $("bar"), tagsEl = $("tags"), shownEl = $("shown");
  const filterNote = $("filter-note"), hintEl = $("hint"), grid = $("grid"), emptyEl = $("empty");
  const selectBar = $("selectbar");

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const pad = (n) => String(n).padStart(2, "0");
  const dpr = (cap) => Math.min(cap, window.devicePixelRatio || 1);
  const plural = (n) => n + (n === 1 ? " photograph" : " photographs");

  // ---- Photos ----
  // Every entry ends up with one ascending list of sizes, `rend`. Manifests
  // without `renditions` only have a thumbnail and the original.
  function normalize(p) {
    const full = p.full || p.file;
    const ar = p.w && p.h ? p.w / p.h : 1.5;
    const thumb = p.thumb || full;
    let rend = Array.isArray(p.renditions)
      ? p.renditions.filter((r) => r && r.src && r.w > 0 && r.h > 0).map((r) => ({ src: r.src, w: r.w, h: r.h }))
      : [];
    const legacy = !rend.length;
    if (legacy) rend = [{ src: thumb, w: 1600, h: Math.round(1600 / ar) }];
    if (full && !rend.some((r) => r.src === full)) {
      rend.push({ src: full, w: p.w || 4000, h: p.h || Math.round(4000 / ar), legacy: legacy });
    }
    rend.sort((a, b) => a.w - b.w);
    return {
      key: full, full: full, thumb: thumb, w: p.w, h: p.h, ar: ar,
      location: p.location || "",
      tags: Array.isArray(p.tags) ? p.tags.filter((t) => typeof t === "string" && t.trim()) : [],
      rend: rend, color: Array.isArray(p.color) ? p.color : null, featured: !!p.featured,
      cell: null, img: null, gridW: 0
    };
  }

  const tagText = (p) => (p && p.tags ? p.tags.join(" · ") : "");
  const altFor = (p) => (p.location ? "Photograph — " + p.location
    : p.tags.length ? "Photograph — " + p.tags.join(", ") : "Photograph");

  // The sizes this device may load: always the smallest, then anything
  // within the pixel budget that hasn't failed to load.
  const usable = (p) => p.rend.filter((r, i) => i === 0 || (!r.failed && (r.legacy || r.w * r.h <= MAX_PIXELS)));
  const pickW = (p, need, list) => { list = list || usable(p); return list.find((r) => r.w >= need) || list[list.length - 1]; };
  const pickH = (p, need, list) => { list = list || usable(p); return list.find((r) => r.h >= need) || list[list.length - 1]; };

  function filtered() {
    return S.tag ? S.photos.filter((p) => p.tags.indexOf(S.tag) !== -1) : S.photos;
  }

  // ---- Ambient colour ----
  // The page, the tag bar and the viewer take a dark tint of the photograph
  // in view. A photo's colour is measured from whichever copy of it loads
  // first, so nothing extra is downloaded for it.
  function toHueSat(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    let h = 0, s = 0;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [Math.round(h), Math.round(s * 100)];
  }

  let colorCanvas = null;
  function sampleColor(source, p) {
    if (p.color || S.colors[p.key]) return;
    try {
      if (!colorCanvas) { colorCanvas = document.createElement("canvas"); colorCanvas.width = colorCanvas.height = 24; }
      const x = colorCanvas.getContext("2d", { willReadFrequently: true });
      x.drawImage(source, 0, 0, 24, 24);
      setColor(p, x.getImageData(0, 0, 24, 24).data);
    } catch (e) {}
  }

  function setColor(p, d) {   // d: RGBA pixels of a tiny copy of the photo
    if (p.color || S.colors[p.key] || !d || !d.length) return;
    let r = 0, g = 0, b = 0, n = 0;
    for (let k = 0; k < d.length; k += 4) {
      // Colourful pixels count for more than grey ones.
      const w = 1 + (Math.max(d[k], d[k + 1], d[k + 2]) - Math.min(d[k], d[k + 1], d[k + 2])) / 24;
      r += d[k] * w; g += d[k + 1] * w; b += d[k + 2] * w; n += w;
    }
    S.colors[p.key] = toHueSat(r / n, g / n, b / n);
    paintTone();
  }

  function tone(key, l, a) {
    const p = key && S.photos.find((x) => x.key === key);
    const c = p ? p.color || S.colors[key] : null;
    const h = c ? c[0] : NEUTRAL[0];
    const s = c ? Math.min(34, Math.round(c[1] * 0.8)) : NEUTRAL[1];
    return a == null ? "hsl(" + h + ", " + s + "%, " + l + "%)" : "hsla(" + h + ", " + s + "%, " + l + "%, " + a + ")";
  }

  function paintTone() {
    const key = S.active || (HERO.cur && HERO.cur.p.key);
    tintEl.style.backgroundColor = tone(key, 10);
    bar.style.backgroundColor = tone(key, 10, 0.84);
    if (V) paintViewerTone();
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

  // ---- Static content ----
  function paintContent() {
    $("site-title").textContent = CONTENT.siteTitle;
    $("site-author").textContent = CONTENT.author;
    $("site-blurb").textContent = CONTENT.siteBlurb;
    $("license-note").textContent = CONTENT.licenseNote;
    $("copyright").textContent = "© " + new Date().getFullYear() + " " + CONTENT.author;
    document.title = CONTENT.siteTitle + " — " + CONTENT.author;
  }

  // ---- Banner ----
  // A slow carousel of photographs behind the title. Each slide is scaled
  // once, off the main thread, to the size it is shown at and handed to the
  // graphics card as a texture; a frame is then a single textured rectangle.
  // Drawing it ourselves -- rather than animating a transform -- keeps the
  // motion in fractions of a pixel, so a slow zoom glides instead of
  // stepping from one whole pixel to the next, and costs next to nothing.
  const HERO = { W: 0, H: 0, list: [], cur: null, prev: null, clock: 0, last: 0, raf: 0, frames: 0, dirty: true, fill: -1, maps: new Map(), token: 0 };

  // CSS "ease", for the cross-fade.
  const EASE = (function (x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    return (x) => {
      let t = x;
      for (let i = 0; i < 8; i++) {
        const f = ((ax * t + bx) * t + cx) * t - x, d = (3 * ax * t + 2 * bx) * t + cx;
        if (Math.abs(f) < 1e-5 || !d) break;
        t -= f / d;
      }
      return ((ay * t + by) * t + cy) * t;
    };
  })(0.25, 0.1, 0.25, 1);

  // What the banner draws with. WebGL when the device has a real graphics
  // card behind it; otherwise a plain 2D canvas at a lower resolution and
  // frame rate, which is the most a processor should be asked to do here.
  // Either way: hold(picture) keeps a scaled slide, begin() starts a frame,
  // and draw() paints the (u, v, uw, vh) part of a slide over the banner.
  const freePicture = (b) => {
    if (!b) return;
    if (b.close) b.close();
    else if (b.tagName === "CANVAS") b.width = b.height = 0;
    else if (b.tagName === "IMG") b.removeAttribute("src");
  };

  function glPainter(canvas) {
    const opts = { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "low-power", failIfMajorPerformanceCaveat: true };
    let two = true, gl = null;
    try { gl = canvas.getContext("webgl2", opts); } catch (e) {}
    if (!gl) { two = false; try { gl = canvas.getContext("webgl", opts); } catch (e) {} }
    if (!gl) return null;
    const VS = "attribute vec2 p; uniform vec4 r; varying highp vec2 v;" +
      "void main() { v = r.xy + vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5) * r.zw; gl_Position = vec4(p, 0.0, 1.0); }";
    const FS = "precision highp float; uniform sampler2D t; uniform float a; varying highp vec2 v;" +
      "void main() { gl_FragColor = vec4(texture2D(t, v).rgb, a); }";
    let uRect = null, uAlpha = null;
    const setup = () => {
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, "p");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      uRect = gl.getUniformLocation(prog, "r");
      uAlpha = gl.getUniformLocation(prog, "a");
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(12 / 255, 11 / 255, 10 / 255, 1);
      return true;
    };
    if (!setup()) return null;
    const P = {
      gl: true, scale: 1.5, lost: false,
      max: Math.min(8192, gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096),
      hold(pic) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pic);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        // Mipmaps keep a slide clean if the window is later made smaller.
        if (two) gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, two ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
        const held = { tex: tex, w: pic.width || pic.naturalWidth, h: pic.height || pic.naturalHeight };
        freePicture(pic);   // the card has it now
        return held;
      },
      drop(held) { if (held && held.tex && !P.lost) gl.deleteTexture(held.tex); },
      begin() {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT);
      },
      draw(held, u, v, uw, vh, alpha) {
        gl.bindTexture(gl.TEXTURE_2D, held.tex);
        gl.uniform4f(uRect, u, v, uw, vh);
        gl.uniform1f(uAlpha, alpha);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    };
    // The browser may take the graphics context away (and give it back).
    // Slides are simply prepared again when it returns.
    canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); P.lost = true; });
    canvas.addEventListener("webglcontextrestored", () => {
      P.lost = !setup();
      HERO.maps.clear();
      heroPrep();
      heroKick();
    });
    return P;
  }

  function flatPainter(canvas) {
    const c = canvas.getContext("2d", { alpha: false });
    return {
      gl: false, scale: 1, lost: false, max: 8192,
      hold(pic) { return { pic: pic, w: pic.width || pic.naturalWidth, h: pic.height || pic.naturalHeight }; },
      drop(held) { if (held) freePicture(held.pic); },
      begin() {
        c.globalAlpha = 1;
        c.fillStyle = "#0c0b0a";
        c.fillRect(0, 0, canvas.width, canvas.height);
      },
      draw(held, u, v, uw, vh, alpha) {
        c.globalAlpha = alpha;
        c.drawImage(held.pic, u * held.w, v * held.h, uw * held.w, vh * held.h, 0, 0, canvas.width, canvas.height);
      }
    };
  }
  const PAINT = glPainter(heroCanvas) || (function () {
    // A canvas that has been asked for WebGL can't then be used for 2D.
    const fresh = heroCanvas.cloneNode(false);
    heroCanvas.replaceWith(fresh);
    heroCanvas = fresh;
    return flatPainter(fresh);
  })();

  // Which photos take a turn in the banner: every one that is wider than it
  // is tall, in an order shuffled afresh on each visit. Upright photos are
  // left out -- the banner would only show a thin slice of them. This goes
  // by shape alone, so newly added photos join (or don't) by themselves.
  function buildHeroList() {
    const all = S.photos;
    let base = all.filter((p) => p.featured);
    if (!base.length) base = all.filter((p) => p.ar >= 1.1);
    if (!base.length) base = all.slice();
    for (let i = base.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = base[i]; base[i] = base[j]; base[j] = t;
    }
    HERO.list = base;
  }

  // How a photo sits in the banner: wider than the banner pans sideways
  // ("x"), an upright one in a wide banner pans down ("y"), and anything
  // else covers the banner and zooms in gently ("kb"). iw x ih is the size
  // of the whole photo on screen, in CSS pixels.
  function heroGeom(p) {
    const W = HERO.W, H = HERO.H, bar = W / H;
    if (p.ar > bar * 1.15) { const iw = H * p.ar; return { kind: "x", iw: iw, ih: H, travel: iw - W }; }
    if (p.ar < 1 && bar >= 1) { const ih = W / p.ar; return { kind: "y", iw: W, ih: ih, travel: (ih - H) * 0.7, start: (ih - H) * 0.15 }; }
    const iw = Math.max(W, H * p.ar);
    return { kind: "kb", iw: iw, ih: iw / p.ar, travel: 0 };
  }

  function heroDur(p) {   // seconds a slide stays up; long pans get longer
    const g = heroGeom(p);
    return g.kind !== "kb" && MOTION.pan ? Math.min(120, Math.max(HERO_SECONDS * 1.5, g.travel / 42)) : HERO_SECONDS;
  }

  const smallRend = (p) => p.rend.filter((r, i) => i === 0 || r.h <= GRID_MAX_H);
  function heroSrc(p, g) {
    // Phones stay with the small copies: sharp enough at their size, and a
    // fraction of the download.
    const list = TOUCH ? smallRend(p) : usable(p);
    return (g.kind === "x" ? pickH(p, HERO.H * 1.4, list) : pickW(p, g.iw * 1.4, list)).src;
  }

  // Scaling slides. Fetching, decoding and shrinking a 12-megapixel JPEG
  // takes long enough to make the banner stutter, so it happens in a worker
  // and only the finished, right-sized picture comes back. Shrinking in one
  // step looks gritty, so the size is halved step by step.
  const WORKER = "self.onmessage = async (e) => {" +
    "const m = e.data;" +
    "try { new OffscreenCanvas(1, 1).getContext('2d').drawImage; } catch (x) { self.postMessage({ id: m.id, unsupported: true }); return; }" +
    "try {" +
    "const res = await fetch(m.url); if (!res.ok) throw 0;" +
    "let src = await createImageBitmap(await res.blob()), w = src.width, h = src.height;" +
    "const tw = Math.max(1, Math.min(m.bw, w)), th = Math.max(1, Math.round(tw * h / w));" +
    "const step = (nw, nh) => { const c = new OffscreenCanvas(nw, nh), x = c.getContext('2d');" +
    "x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, w, h, 0, 0, nw, nh);" +
    "if (src.close) src.close(); else src.width = src.height = 0; src = c; w = nw; h = nh; };" +
    "while (w / tw > 2) step(Math.ceil(w / 2), Math.ceil(h / 2));" +
    "if (w !== tw || !src.transferToImageBitmap) step(tw, th);" +
    "const s = new OffscreenCanvas(24, 24), sx = s.getContext('2d'); sx.drawImage(src, 0, 0, 24, 24);" +
    "const px = Array.from(sx.getImageData(0, 0, 24, 24).data);" +
    "const out = src.transferToImageBitmap();" +
    "self.postMessage({ id: m.id, bitmap: out, px: px }, [out]);" +
    "} catch (x) { self.postMessage({ id: m.id, failed: true }); } };";
  let worker = null, workerOK = typeof Worker === "function" && typeof OffscreenCanvas === "function" && typeof createImageBitmap === "function";
  const jobs = new Map();
  let jobId = 0;

  function scaleInWorker(src, bw, bh) {
    return new Promise((res, rej) => {
      try {
        if (!worker) {
          const url = URL.createObjectURL(new Blob([WORKER], { type: "text/javascript" }));
          worker = new Worker(url);
          worker.onmessage = (e) => {
            const job = jobs.get(e.data.id);
            if (!job) { freePicture(e.data.bitmap); return; }
            jobs.delete(e.data.id);
            if (e.data.unsupported) { workerOK = false; job.retry(); }
            else if (e.data.failed) job.rej(new Error("load failed"));
            else job.res({ pic: e.data.bitmap, px: e.data.px });
          };
          worker.onerror = () => {
            workerOK = false;
            for (const job of jobs.values()) job.retry();
            jobs.clear();
          };
        }
        const id = ++jobId;
        jobs.set(id, { res: res, rej: rej, retry: () => scaleHere(src, bw, bh).then(res, rej) });
        worker.postMessage({ id: id, url: new URL(src, location.href).href, bw: bw, bh: bh });
      } catch (e) {
        workerOK = false;
        scaleHere(src, bw, bh).then(res, rej);
      }
    });
  }

  // The same job on the main thread, for browsers without the pieces above.
  const nextTask = () => new Promise((r) => setTimeout(r, 0));
  function scaleHere(url, bw, bh) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.decoding = "async";
      im.onload = () => (im.decode ? im.decode().catch(() => {}) : Promise.resolve()).then(() => res(im));
      im.onerror = rej;
      im.src = url;
    }).then(async (img) => {
      let src = img, w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) throw new Error("empty image");
      const tw = Math.max(1, Math.min(bw, w)), th = Math.max(1, Math.round((tw * h) / w));
      const step = (nw, nh) => {
        const to = document.createElement("canvas");
        to.width = nw; to.height = nh;
        const c = to.getContext("2d");
        c.imageSmoothingEnabled = true; c.imageSmoothingQuality = "high";
        c.drawImage(src, 0, 0, w, h, 0, 0, nw, nh);
        freePicture(src);
        src = to; w = nw; h = nh;
      };
      while (w / tw > 2) {
        step(Math.ceil(w / 2), Math.ceil(h / 2));
        await nextTask();   // let a frame through between the heavy steps
      }
      step(tw, th);
      return { pic: src, px: null };
    });
  }
  const scaled = (src, bw, bh) => (workerOK ? scaleInWorker(src, bw, bh) : scaleHere(src, bw, bh));

  // Make sure a slide's scaled copy exists (or is on its way) at the size
  // the banner needs now. A quick small copy goes up first so the banner is
  // never blank while the large one downloads.
  function ensureSlide(p) {
    if (!HERO.W || !HERO.H || PAINT.lost) return;
    const g = heroGeom(p);
    let k = dpr(PAINT.scale) * (g.kind === "kb" ? MOTION.kb : 1);
    k = Math.min(k, PAINT.max / g.iw, PAINT.max / g.ih, Math.sqrt(8e6 / (g.iw * g.ih)));
    const bw = Math.max(1, Math.round(g.iw * k)), bh = Math.max(1, Math.round(g.ih * k));
    let e = HERO.maps.get(p.key);
    if (e && (e.failed || e.want >= bw / 1.15)) return;
    if (!e) { e = { held: null, want: 0, failed: false, token: 0 }; HERO.maps.set(p.key, e); }
    e.want = bw;
    const token = e.token = ++HERO.token;
    const live = () => HERO.maps.get(p.key) === e && e.token === token && !PAINT.lost;
    const take = (r) => {
      if (!live() || (e.held && (r.pic.width || r.pic.naturalWidth) < e.held.w)) { freePicture(r.pic); return; }
      if (r.px) setColor(p, r.px); else sampleColor(r.pic, p);
      PAINT.drop(e.held);
      e.held = PAINT.hold(r.pic);
      HERO.dirty = true;
      if (!HERO.raf) { drawHero(); heroKick(); }
    };
    const want = heroSrc(p, g), small = smallRend(p), quick = small[small.length - 1].src;
    const load = (src) => scaled(src, bw, bh).then(take);
    if (!e.held && quick !== want) load(quick).catch(() => {});
    load(want).catch(() => { if (live() && !e.held) load(quick).catch(() => { if (live() && !e.held) e.failed = true; }); });
  }

  // Keep the current, previous and next slides only; everything else is
  // released straight away rather than left for the browser to tidy up.
  function heroPrep() {
    const L = HERO.list, keep = new Set();
    if (HERO.cur) {
      keep.add(HERO.cur.p);
      if (L.length > 1) keep.add(L[(L.indexOf(HERO.cur.p) + 1) % L.length]);
    }
    if (HERO.prev) keep.add(HERO.prev.p);
    const keys = new Set([...keep].map((p) => p.key));
    for (const [key, e] of HERO.maps) {
      if (!keys.has(key)) { e.token = 0; PAINT.drop(e.held); HERO.maps.delete(key); }
    }
    for (const p of keep) ensureSlide(p);
  }

  function heroShow(n) {
    const L = HERO.list;
    if (!L.length) return;
    const p = L[((n % L.length) + L.length) % L.length];
    if (HERO.cur && HERO.cur.p === p) return;
    // A slide that has started showing stays underneath while the new one
    // fades in over it, so the banner never dips to black in between.
    if (HERO.cur && HERO.cur.t0 != null) HERO.prev = HERO.cur;
    HERO.cur = { p: p, t0: null };
    HERO.dirty = true;
    heroPrep();
    paintHeroMeta();
    paintTone();
    heroKick();
  }
  const heroStep = (d) => { if (HERO.cur) heroShow(HERO.list.indexOf(HERO.cur.p) + d); };

  function paintHeroMeta() {
    const L = HERO.list, p = HERO.cur && HERO.cur.p;
    heroIndex.textContent = p ? pad(L.indexOf(p) + 1) + " / " + pad(L.length) : "";
    heroCaption.textContent = p ? p.location || tagText(p) : "";
  }

  function sizeHero() {
    const k = dpr(PAINT.scale);
    const cw = Math.max(1, Math.round(HERO.W * k)), ch = Math.max(1, Math.round(HERO.H * k));
    if (heroCanvas.width !== cw || heroCanvas.height !== ch) { heroCanvas.width = cw; heroCanvas.height = ch; }
    heroPrep();
    drawHero();
    heroKick();
  }

  function drawSlide(s, alpha) {
    const p = s.p, e = HERO.maps.get(p.key);
    if (!e || !e.held) return;
    const W = HERO.W, H = HERO.H, g = heroGeom(p);
    // Motion runs on through the cross-fade to the next slide.
    const prog = clamp((HERO.clock - s.t0) / (heroDur(p) * 1000 + HERO_FADE), 0, 1);
    let ix = 0, iy = 0, z = 1;
    if (g.kind === "x") ix = MOTION.pan ? -g.travel * prog : -g.travel / 2;
    else if (g.kind === "y") iy = MOTION.pan ? -(g.start + g.travel * prog) : -(g.start + g.travel / 2);
    else { ix = (W - g.iw) / 2; iy = (H - g.ih) / 2; z = 1 + (MOTION.kb - 1) * prog; }
    // The part of the photo the banner shows right now, as fractions of it.
    const uw = Math.min(1, W / z / g.iw), vh = Math.min(1, H / z / g.ih);
    const u = clamp((W / 2 - W / 2 / z - ix) / g.iw, 0, 1 - uw);
    const v = clamp((H / 2 - H / 2 / z - iy) / g.ih, 0, 1 - vh);
    PAINT.draw(e.held, u, v, uw, vh, alpha);
  }

  function drawHero() {
    if (PAINT.lost) return;
    HERO.dirty = false;
    PAINT.begin();
    const A = HERO.cur, P = HERO.prev;
    const a = A && A.t0 != null ? EASE(Math.min(1, (HERO.clock - A.t0) / HERO_FADE)) : 0;
    if (P && a < 1) drawSlide(P, 1);
    if (a > 0) drawSlide(A, a);
  }

  // The banner only runs while it's on screen and nothing covers it, and
  // only moves on to the next photo while the reader is still at the top.
  const heroOnScreen = () => HERO.list.length > 0 && !S.open && !document.hidden && window.scrollY < HERO.H;
  const heroMayAdvance = () => !S.gateOpen && window.scrollY < HERO.H * 0.8;

  function heroKick() {
    if (!HERO.raf && heroOnScreen()) HERO.raf = requestAnimationFrame(heroFrame);
  }

  function heroFrame(now) {
    HERO.raf = 0;
    if (!heroOnScreen()) { HERO.last = 0; return; }
    // The banner keeps its own clock, which stops whenever the banner does,
    // so it always picks up exactly where it left off.
    if (HERO.last) HERO.clock += Math.min(100, now - HERO.last);
    HERO.last = now;
    HERO.frames++;
    const L = HERO.list, A = HERO.cur;
    let every = 2;   // how often a frame is actually drawn
    if (A) {
      const e = HERO.maps.get(A.p.key);
      if (A.t0 == null && e && e.held) { A.t0 = HERO.clock; HERO.dirty = true; }
      const dur = heroDur(A.p) * 1000, t = A.t0 == null ? 0 : HERO.clock - A.t0;
      // The progress line only needs touching when it has moved half a pixel.
      const fill = Math.round(Math.min(1, t / dur) * 360) / 360;
      if (fill !== HERO.fill) { HERO.fill = fill; heroFill.style.transform = "scaleX(" + fill + ")"; }
      const stuck = A.t0 == null && e && e.failed;
      if ((t >= dur || stuck) && L.length > 1 && heroMayAdvance()) {
        const nx = L[(L.indexOf(A.p) + 1) % L.length], ne = HERO.maps.get(nx.key);
        if (ne && ne.held) heroShow(L.indexOf(nx));
        else if (ne && ne.failed) { L.splice(L.indexOf(nx), 1); heroPrep(); paintHeroMeta(); }
      }
      // A cross-fade or a sideways pan is drawn on every frame. A slow zoom
      // moves a tenth of a pixel per frame, so every other frame looks the
      // same and costs half as much; a still banner isn't redrawn at all.
      const fading = A.t0 != null && t < HERO_FADE;
      const moving = A.t0 != null && (MOTION.kb > 1 || MOTION.pan) && t < dur + HERO_FADE;
      const panning = moving && MOTION.pan && heroGeom(A.p).kind !== "kb";
      every = fading || panning ? (PAINT.gl ? 1 : 2) : moving ? 2 : 0;
    }
    if (HERO.dirty || (every && HERO.frames % every === 0)) drawHero();
    HERO.raf = requestAnimationFrame(heroFrame);
  }

  function openHero() {
    const p = HERO.cur && HERO.cur.p;
    if (!p) return;
    if (filtered().indexOf(p) < 0) setTag(null, true);
    openAt(filtered().indexOf(p), null);
  }

  // ---- Tags ----
  const slugify = (s) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  function buildTags() {
    const counts = {};
    for (const p of S.photos) for (const t of p.tags) counts[t] = (counts[t] || 0) + 1;
    const names = Object.keys(counts).sort((a, b) => a.localeCompare(b));
    // A shared link carries the tag as ?tag=its-slug.
    if (S.tag) S.tag = names.find((t) => t === S.tag || slugify(t) === S.tag) || null;

    while (tagsEl.children.length > 1) tagsEl.removeChild(tagsEl.lastChild);
    const chip = (name, label, count) => {
      const b = el("button", "chip");
      b.type = "button";
      b.dataset.tag = name || "";
      b.append(el("b", null, label), el("span", null, String(count)));
      b.firstChild.style.fontWeight = "inherit";
      b.addEventListener("click", () => setTag(name && S.tag === name ? null : name));
      tagsEl.appendChild(b);
    };
    chip(null, "All photos", S.photos.length);
    for (const t of names) chip(t, t, counts[t]);
    paintTags();
  }

  function paintTags() {
    for (const b of tagsEl.querySelectorAll(".chip")) b.setAttribute("aria-pressed", String(b.dataset.tag === (S.tag || "")));
    const photos = filtered();
    shownEl.textContent = S.loaded ? plural(photos.length) : "";
    filterNote.hidden = !S.tag;
    filterNote.textContent = "";
    if (S.tag) {
      const total = S.photos.length;
      const b = el("button", "show-all", "Show all " + total);
      b.type = "button";
      b.addEventListener("click", () => setTag(null));
      filterNote.append("Showing " + photos.length + " of " + total + " photographs. ", b);
    }
  }

  function setTag(name, stay) {
    S.tag = name || null;
    S.i = 0;
    try {
      const u = new URL(location.href);
      if (S.tag) u.searchParams.set("tag", slugify(S.tag)); else u.searchParams.delete("tag");
      history.replaceState(null, "", u);
    } catch (e) {}
    paintTags();
    layout();
    paintSelectBar();
    // A different set of photos starts from its first row.
    if (!stay) {
      const top = marker.getBoundingClientRect().top + window.scrollY;
      if (window.scrollY > top + 2) window.scrollTo({ top: top, behavior: REDUCED ? "auto" : "smooth" });
    }
    schedule();
  }

  // Lets a mouse drag a sideways-scrolling row, as a finger would.
  function dragScroller(node) {
    const st = { on: false, moved: false, x: 0, sl: 0 };
    node.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse" || e.button) return;
      st.x = e.clientX; st.sl = node.scrollLeft; st.on = true; st.moved = false;
    });
    node.addEventListener("pointermove", (e) => {
      if (!st.on) return;
      const dx = e.clientX - st.x;
      if (!st.moved && Math.abs(dx) > 6 && node.scrollWidth > node.clientWidth) st.moved = true;
      if (st.moved) { node.scrollLeft = st.sl - dx; e.preventDefault(); }
    });
    const up = () => { st.on = false; };
    node.addEventListener("pointerup", up);
    node.addEventListener("pointerleave", up);
    // The click that ends a drag is not a click on whatever was under it.
    node.addEventListener("click", (e) => {
      if (st.moved) { e.preventDefault(); e.stopPropagation(); st.moved = false; }
    }, true);
  }

  // ---- Grid ----
  let rowNodes = [];
  let lp = null;   // the press that may become a long press

  function cancelLp() {
    if (lp) clearTimeout(lp.t);
    lp = null;
  }

  function buildCells() {
    grid.textContent = "";
    rowNodes = [];
    for (const p of S.photos) {
      const a = el("a", "cell");
      a.href = p.full;
      a.setAttribute("aria-label", altFor(p));
      const img = document.createElement("img");
      img.alt = altFor(p);
      img.loading = "lazy";
      img.decoding = "async";
      img.draggable = false;
      img.addEventListener("load", () => sampleColor(img, p));
      const check = el("span", "check", "✓");
      check.setAttribute("role", "checkbox");
      check.setAttribute("aria-checked", "false");
      check.setAttribute("aria-label", "Select photograph");
      check.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); toggleSel(p); });
      check.addEventListener("pointerdown", (e) => e.stopPropagation());
      a.append(img, check);

      a.addEventListener("click", (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;   // let the browser open the file
        e.preventDefault();
        if (lp && lp.fired && lp.p === p) { lp = null; return; }   // the click that ends a long press
        if (S.sel.size) { toggleSel(p); return; }
        openAt(filtered().indexOf(p), a);
      });
      // Press and hold (finger or mouse) to select, as in a phone's gallery.
      // Moving first means a scroll or a drag, not a hold.
      a.addEventListener("pointerdown", (e) => {
        if (e.button) return;
        cancelLp();
        const me = { p: p, x: e.clientX, y: e.clientY, touch: e.pointerType === "touch", fired: false, t: 0 };
        me.t = setTimeout(() => {
          me.fired = true;
          toggleSel(p, true);
          try { if (navigator.vibrate) navigator.vibrate(12); } catch (er) {}
        }, 450);
        lp = me;
      });
      a.addEventListener("pointermove", (e) => {
        if (lp && !lp.fired && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) cancelLp();
      });
      const end = () => { if (lp && !lp.fired) cancelLp(); };
      for (const type of ["pointerup", "pointerleave", "pointercancel"]) a.addEventListener(type, end);
      a.addEventListener("contextmenu", (e) => { if (lp && (lp.fired || lp.touch)) e.preventDefault(); });
      a.addEventListener("dragstart", (e) => e.preventDefault());
      p.cell = a;
      p.img = img;
    }
    emptyEl.hidden = !S.loaded || S.photos.length > 0;
    hintEl.hidden = S.loaded && S.photos.length === 0;
  }

  // Row height follows the available width (and is capped by the screen's
  // height), so every screen gets a sensible number of photos per row.
  function rowTarget() {
    const w = S.width || 1200, vh = S.vh || 800;
    const t = w < 560 ? w * 0.45 : Math.min(360, Math.max(200, w * 0.2));
    return Math.round(Math.min(t, Math.max(140, vh * 0.42)));
  }

  // Justified rows: each row closes at whichever break (with or without the
  // next photo) lands nearest the target height.
  function buildRows(items, gap) {
    const width = S.width || 1200, target = rowTarget();
    const rows = [];
    let run = [], arSum = 0;
    const flush = (scaled) => {
      if (!run.length) return;
      const h = scaled ? Math.min(target * 1.3, (width - gap * (run.length - 1)) / arSum) : target;
      rows.push({ items: run, height: Math.max(40, Math.round(h)) });
      run = []; arSum = 0;
    };
    for (const it of items) {
      // Wide panoramas always get a row to themselves; whatever precedes
      // them closes (ragged if need be).
      if (it.ar * target >= width * 0.85) {
        flush(true);
        rows.push({ items: [it], height: Math.max(40, Math.round(width / it.ar)) });
        continue;
      }
      const arNew = arSum + it.ar;
      if (arNew * target + gap * run.length < width) { run.push(it); arSum = arNew; continue; }
      const hA = (width - gap * run.length) / arNew;
      const hB = run.length ? (width - gap * (run.length - 1)) / arSum : Infinity;
      if (Math.abs(Math.log(hA / target)) <= Math.abs(Math.log(hB / target))) { run.push(it); arSum = arNew; flush(true); }
      else { flush(true); run.push(it); arSum = it.ar; if (it.ar * target >= width) flush(true); }
    }
    flush(false);
    return rows;
  }

  function layout() {
    const photos = filtered();
    const gap = S.vw < 720 ? 6 : 8;
    grid.style.setProperty("--gap", gap + "px");
    const shown = new Set(photos);
    for (const p of S.photos) if (!shown.has(p) && p.cell && p.cell.parentNode) p.cell.remove();
    const rows = photos.length ? buildRows(photos, gap) : [];

    // Reuse row containers so cells are never needlessly detached, which
    // would replay their entrance and re-decode their images.
    while (rowNodes.length < rows.length) {
      const r = el("div", "row");
      grid.appendChild(r);
      rowNodes.push(r);
    }
    while (rowNodes.length > rows.length) grid.removeChild(rowNodes.pop());

    const density = dpr(2);
    rows.forEach((row, ri) => {
      const node = rowNodes[ri], h = row.height;
      row.items.forEach((p, k) => {
        const c = p.cell;
        c.style.width = Math.round(h * p.ar) + "px";
        c.style.height = h + "px";
        c.style.setProperty("--d", Math.min(0.24, k * 0.05) + "s");
        // The smaller grid copy if it's sharp at this size, else the larger.
        const r = p.rend.slice(0, 2).find((x) => x.h >= h * density * 0.9) || p.rend[Math.min(1, p.rend.length - 1)];
        if (r.w > p.gridW) { p.gridW = r.w; p.img.src = r.src; }
        if (node.children[k] !== c) node.insertBefore(c, node.children[k] || null);
      });
      while (node.children.length > row.items.length) node.removeChild(node.lastChild);
    });
  }

  // ---- Scroll ----
  // Reveals photos as they come into view, and tracks the one nearest the
  // middle of the screen: the page takes its tint from that one.
  let tickRaf = 0;
  function schedule() {
    if (tickRaf) return;
    tickRaf = requestAnimationFrame(() => { tickRaf = 0; tick(); });
  }

  function tick() {
    const vh = window.innerHeight;
    let best = null, bestD = Infinity;
    for (const p of filtered()) {
      const c = p.cell;
      if (!c || !c.parentNode) continue;
      const r = c.getBoundingClientRect();
      if (r.top < vh * 0.95 && r.bottom > 0 && !p.seen) { p.seen = true; c.classList.add("seen"); }
      const d = Math.abs(r.top + r.height / 2 - vh / 2);
      if (r.bottom > 0 && r.top < vh && d < bestD) { bestD = d; best = p.key; }
    }
    const active = window.scrollY < HERO.H * 0.6 ? null : best;
    if (active !== S.active) { S.active = active; paintTone(); }
    heroKick();
  }

  function measure() {
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const w = Math.round(grid.getBoundingClientRect().width);
    const changed = vw !== S.vw || vh !== S.vh || (w > 0 && w !== S.width);
    S.vw = vw; S.vh = vh;
    if (w > 0) S.width = w;
    const hr = heroEl.getBoundingClientRect(), hw = Math.round(hr.width), hh = Math.round(hr.height);
    if (hw !== HERO.W || hh !== HERO.H) { HERO.W = hw; HERO.H = hh; sizeHero(); }
    if (changed) {
      layout();
      if (V && S.phase !== "closing") {
        const g = geom(cur());
        S.zoom = clampZ(g, S.zoom.z, S.zoom.ox, S.zoom.oy);
        S.zAnim = false;
        paintViewer();
      }
    }
    schedule();
  }

  // ---- Selecting photos to download together ----
  function toggleSel(p, forceOn) {
    if (S.sel.has(p.key) && !forceOn) S.sel.delete(p.key); else S.sel.add(p.key);
    paintSel();
  }

  function clearSel() {
    S.sel.clear();
    paintSel();
  }

  function paintSel() {
    document.body.classList.toggle("selecting", S.sel.size > 0);
    for (const p of S.photos) {
      const on = S.sel.has(p.key);
      p.cell.classList.toggle("sel", on);
      p.cell.lastChild.setAttribute("aria-checked", String(on));
    }
    hintEl.textContent = S.sel.size ? "" : "Hold a photo to select several for download";
    paintSelectBar();
  }

  let sb = null;
  function paintSelectBar() {
    const n = S.sel.size;
    selectBar.hidden = n === 0;
    if (!n) return;
    if (!sb) {
      const button = (cls, fn) => { const b = el("button", cls); b.type = "button"; b.addEventListener("click", fn); return b; };
      sb = { count: el("span", "sb-count") };
      sb.all = button("sb-quiet", () => {
        const photos = filtered();
        if (photos.length && photos.every((p) => S.sel.has(p.key))) { clearSel(); return; }
        for (const p of photos) S.sel.add(p.key);
        paintSel();
      });
      sb.go = button("sb-go", () => downloadSet(S.photos.filter((p) => S.sel.has(p.key)), sb.go, clearSel));
      sb.cancel = button("sb-quiet", clearSel);
      sb.cancel.textContent = "Cancel";
      selectBar.append(sb.count, sb.all, sb.go, sb.cancel);
    }
    const photos = filtered();
    sb.count.textContent = n + " selected";
    sb.all.textContent = photos.length && photos.every((p) => S.sel.has(p.key)) ? "Deselect all" : "Select all " + photos.length;
    if (!downloading) sb.go.textContent = "Download " + n;
  }

  // ---- Downloads ----
  function triggerDownload(url, name) {
    const a = document.createElement("a");
    a.href = url;
    a.download = name || decodeURIComponent((url.split("/").pop() || "").split("?")[0]) || "photograph.jpg";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // Desktop browsers accept a run of ordinary downloads, so each photo
  // arrives as its own file. Mobile browsers only honour the first, so
  // phones get the photos in a single .zip instead (stored, not compressed:
  // JPEGs don't shrink, so that needs only a CRC per file and some headers).
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function zipBlob(files) {   // files: [{ name, data: Uint8Array }]
    const enc = new TextEncoder();
    const now = new Date();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
      const head = new DataView(new ArrayBuffer(30));
      head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true);
      head.setUint16(10, time, true); head.setUint16(12, date, true); head.setUint32(14, crc, true);
      head.setUint32(18, size, true); head.setUint32(22, size, true); head.setUint16(26, name.length, true);
      parts.push(head, name, f.data);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
      cd.setUint16(12, time, true); cd.setUint16(14, date, true); cd.setUint32(16, crc, true);
      cd.setUint32(20, size, true); cd.setUint32(24, size, true); cd.setUint16(28, name.length, true);
      cd.setUint32(42, offset, true);
      central.push(cd, name);
      offset += 30 + name.length + size;
    }
    const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: "application/zip" });
  }

  let downloading = false;
  // `button` (optional) shows progress; `done` runs once everything is saved.
  function downloadSet(photos, button, done) {
    if (!photos.length || downloading) return;
    const say = (text) => { if (button) button.textContent = text; };
    const run = async () => {
      downloading = true;
      const original = button ? button.textContent : "";
      if (button) button.disabled = true;
      let ok = false;
      try {
        if (!TOUCH || photos.length === 1) {
          for (let i = 0; i < photos.length; i++) {
            if (photos.length > 1) say("Downloading " + (i + 1) + " of " + photos.length + "…");
            triggerDownload(photos[i].full);
            if (i < photos.length - 1) await new Promise((r) => setTimeout(r, 700));
          }
        } else {
          const files = [];
          for (let i = 0; i < photos.length; i++) {
            say("Preparing " + (i + 1) + " of " + photos.length + "…");
            const res = await fetch(photos[i].full);
            if (!res.ok) throw new Error("fetch failed");
            files.push({ name: photos[i].full.split("/").pop(), data: new Uint8Array(await res.arrayBuffer()) });
          }
          const url = URL.createObjectURL(zipBlob(files));
          triggerDownload(url, "photographs.zip");
          setTimeout(() => URL.revokeObjectURL(url), 60000);
        }
        say(original);
        ok = true;
      } catch (e) {
        say("Failed — try again");
        setTimeout(() => say(original), 4000);
      } finally {
        downloading = false;
        if (button) button.disabled = false;
      }
      if (ok && done) done();
    };
    if (S.agreed) run(); else openGate(run);
  }

  // ---- License gate ----
  let gate = null;

  function openGate(then) {
    if (gate) return;
    S.gateOpen = true;

    gate = el("div", "gate-backdrop");
    gate.addEventListener("click", closeGate);

    const box = el("div", "gate");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Before you download");
    box.addEventListener("click", (e) => e.stopPropagation());

    box.appendChild(el("h2", null, "Before you download"));
    const p1 = el("p");
    const link = el("a", null, "CC BY-NC 4.0");
    link.href = "https://creativecommons.org/licenses/by-nc/4.0/";
    link.target = "_blank";
    link.rel = "license noopener";
    p1.append("These photographs are licensed under ", link,
      ". You may share and adapt them for any non-commercial purpose, as long as you credit " +
      CONTENT.author + " and note any changes you made.");
    box.appendChild(p1);
    box.appendChild(el("p", "last", "Commercial use is not permitted without permission."));

    const actions = el("div", "gate-actions");
    const agree = el("button", "btn-solid", "I agree — download");
    agree.type = "button";
    agree.addEventListener("click", (e) => {
      e.stopPropagation();
      rememberAgreement();
      S.agreed = true;
      closeGate();
      if (then) then();
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
    S.gateOpen = false;
    if (gate) { gate.remove(); gate = null; }
  }

  // ---- Viewer ----
  // The photo lifts out of the grid into a frame that fits the screen, and
  // settles back into its place on close. Zoom and pan are a transform on
  // the layer inside that frame: (ox, oy) is its offset from centre and z
  // its scale.
  let V = null;          // the viewer's DOM while it is open
  let zLive = null;      // zoom during a gesture, before it's committed
  let closeT = 0, wheelT = 0, lastFocus = null;
  const ptrs = new Map();
  let gest = null, lastTap = null, suppress = 0, dblAt = 0;

  const cur = () => filtered()[S.i];

  function geom(p) {
    const vw = S.vw, vh = S.vh, ar = p ? p.ar : 1.5;
    const side = Math.max(16, vw * 0.04), top = 64, bottom = vw >= 900 ? 132 : 230;
    const aw = Math.max(120, vw - side * 2), ah = Math.max(120, vh - top - bottom);
    let tw = aw, th = aw / ar;
    if (th > ah) { th = ah; tw = ah * ar; }
    const list = p ? usable(p) : null;
    const fullW = list ? list[list.length - 1].w : 4000;
    return { tx: (vw - tw) / 2, ty: top + (ah - th) / 2, tw: tw, th: th, vw: vw, vh: vh, zMax: Math.max(2, Math.min(8, fullW / tw)) };
  }

  // Keep a zoomed photo from being dragged off: centred while it's smaller
  // than the screen, edge to edge once it's larger.
  function clampZ(g, z, ox, oy) {
    z = clamp(z, 1, g.zMax);
    if (z <= 1.001) return { z: 1, ox: 0, oy: 0 };
    const lim = (o, half, bc, size) => { const a = half - bc, b = size - half - bc; return Math.max(Math.min(a, b), Math.min(Math.max(a, b), o)); };
    return { z: z, ox: lim(ox, (g.tw * z) / 2, g.tx + g.tw / 2, g.vw), oy: lim(oy, (g.th * z) / 2, g.ty + g.th / 2, g.vh) };
  }

  // Zoom to z keeping the photo point under (mx, my) where it is.
  function zoomAt(base, z, mx, my) {
    const g = geom(cur());
    z = clamp(z, 1, g.zMax);
    const bx = g.tx + g.tw / 2, by = g.ty + g.th / 2;
    const ux = (mx - bx - base.ox) / base.z, uy = (my - by - base.oy) / base.z;
    return { z: z, ox: mx - bx - ux * z, oy: my - by - uy * z };
  }

  function liveZoom(n) {
    const c = clampZ(geom(cur()), n.z, n.ox, n.oy);
    zLive = c;
    if (V) { V.inner.style.transition = "none"; V.inner.style.transform = "translate(" + c.ox + "px, " + c.oy + "px) scale(" + c.z + ")"; }
  }

  function commitLive() {
    const c = zLive;
    zLive = null;
    if (c) setZoom(c.z, c.ox, c.oy, false);
  }

  function setZoom(z, ox, oy, anim) {
    const p = cur();
    if (!p || !V) return;
    const g = geom(p);
    S.zoom = clampZ(g, z, ox, oy);
    S.zAnim = !!anim;
    // Zoomed in, fetch a copy sharp enough for it. Nothing is ever downgraded.
    if (S.zoom.z > 1.05) showLayer(pickW(p, g.tw * S.zoom.z * dpr(2)));
    paintViewer();
  }

  function toggleZoomAt(mx, my) {
    const base = S.zoom;
    if (base.z > 1.01) { setZoom(1, 0, 0, true); return; }
    const n = zoomAt(base, Math.min(geom(cur()).zMax, 3), mx, my);
    setZoom(n.z, n.ox, n.oy, true);
  }
  function toggleZoomCenter() {
    const g = geom(cur());
    toggleZoomAt(g.tx + g.tw / 2, g.ty + g.th / 2);
  }
  function zoomBy(f) {
    const g = geom(cur()), base = S.zoom;
    const n = zoomAt(base, base.z * f, g.tx + g.tw / 2, g.ty + g.th / 2);
    setZoom(n.z, n.ox, n.oy, true);
  }

  const toPhase = (ph) => requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!V || S.phase === "closing") return;
    S.phase = ph;
    paintViewer();
  }));

  // Where an element sits on screen, or null when it's out of view.
  function rectOf(node) {
    if (!node || !node.parentNode) return null;
    const r = node.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight || !r.width) return null;
    return { l: r.left, t: r.top, w: r.width, h: r.height };
  }

  function buildViewer() {
    const v = { layerW: 0 };
    v.root = el("div", "viewer");
    v.root.setAttribute("role", "dialog");
    v.root.setAttribute("aria-modal", "true");
    v.root.setAttribute("aria-label", "Photograph viewer");
    v.backdrop = el("div", "v-backdrop");
    v.box = el("div", "v-box");
    v.box.dataset.vbox = "";
    v.inner = el("div", "v-inner");
    v.box.appendChild(v.inner);

    const button = (cls, label, fn, aria) => {
      const b = el("button", cls, label);
      b.type = "button";
      if (aria) b.setAttribute("aria-label", aria);
      b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    v.prev = button("v-arrow v-prev", "←", () => step(-1), "Previous photograph");
    v.next = button("v-arrow v-next", "→", () => step(1), "Next photograph");
    v.prev.dataset.chrome = v.next.dataset.chrome = "";

    v.top = el("div", "v-chrome v-top");
    const meta = el("div", "v-meta");
    v.index = el("span", "v-index");
    v.tags = el("span", "v-tags");
    v.location = el("span", "v-location");
    meta.append(v.index, v.tags, v.location);
    v.close = button("v-close", "Close", close);
    v.top.append(meta, v.close);

    v.bottom = el("div", "v-chrome v-bottom");
    const tools = el("div", "v-tools");
    v.strip = el("div", "v-strip");
    v.strip.dataset.striprow = "";
    dragScroller(v.strip);
    v.thumbs = filtered().map((p, idx) => {
      const b = button("v-thumb", null, () => { if (idx !== S.i) go(idx, idx > S.i ? 1 : -1); }, "Show photograph " + (idx + 1));
      b.style.width = Math.min(150, Math.round(44 * p.ar)) + "px";
      const im = document.createElement("img");
      im.alt = ""; im.loading = "lazy"; im.draggable = false; im.src = p.rend[0].src;
      b.appendChild(im);
      v.strip.appendChild(b);
      return b;
    });
    const buttons = el("div", "v-buttons");
    v.zoomBtn = button("v-zoom", "Zoom", toggleZoomCenter);
    v.dl = el("a", "v-download", "Download full size");
    v.dl.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const p = cur();
      if (p) downloadSet([p]);
    });
    buttons.append(v.zoomBtn, v.dl);
    tools.append(v.strip, buttons);
    v.bottom.append(tools, el("p", "v-note", CONTENT.downloadNote));

    for (const c of [v.top, v.bottom]) {
      c.dataset.chrome = "";
      c.addEventListener("click", (e) => e.stopPropagation());
    }
    v.root.append(v.backdrop, v.box, v.prev, v.next, v.top, v.bottom);

    v.root.addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.closest && (t.closest("[data-vbox]") || t.closest("[data-chrome]"))) return;
      if (Date.now() - suppress < 350) return;   // the click that ends a drag or pinch
      close();
    });
    v.root.addEventListener("pointerdown", vDown);
    v.root.addEventListener("pointermove", vMove);
    v.root.addEventListener("pointerup", vUp);
    v.root.addEventListener("pointercancel", vUp);
    v.box.addEventListener("dblclick", (e) => {
      if (Date.now() - dblAt < 500) return;   // already handled as a double tap
      toggleZoomAt(e.clientX, e.clientY);
    });
    document.body.appendChild(v.root);
    return v;
  }

  // One more, sharper copy of the current photo on top of what's showing.
  // It fades in once it has loaded; a copy that fails is ruled out and the
  // next best one is tried.
  function showLayer(r) {
    const p = cur();
    if (!V || !p || !r || r.w <= V.layerW) return;
    V.layerW = r.w;
    const im = document.createElement("img");
    im.alt = ""; im.draggable = false; im.decoding = "async";
    im.style.opacity = "0";
    im.addEventListener("load", () => { im.style.opacity = "1"; sampleColor(im, p); });
    im.addEventListener("error", () => {
      if (!V || cur() !== p) return;
      r.failed = true;
      im.remove();
      V.layerW = 0;
      const g = geom(p);
      showLayer(pickW(p, g.tw * Math.max(1, S.zoom.z) * dpr(2)));
    });
    im.src = r.src;
    V.inner.appendChild(im);
  }

  // Everything that depends on which photo is showing.
  function showPhoto() {
    const p = cur(), n = filtered().length;
    V.inner.textContent = "";
    V.layerW = 0;
    // Start from the copy the grid already has, so there is no wait.
    const low = document.createElement("img");
    const have = p.img && p.img.complete && p.img.naturalWidth ? p.img.currentSrc || p.img.src : "";
    low.alt = p.location ? "Photograph — " + p.location : "Photograph";
    low.draggable = false;
    low.addEventListener("load", () => sampleColor(low, p));
    low.src = have || p.rend[0].src;
    V.inner.appendChild(low);
    showLayer(pickW(p, geom(p).tw * dpr(2)));

    V.index.textContent = pad(S.i + 1) + " / " + pad(n);
    V.tags.textContent = tagText(p);
    V.location.textContent = p.location;
    V.dl.href = p.full;
    V.thumbs.forEach((b, idx) => b.setAttribute("aria-current", String(idx === S.i)));
    for (const x of S.photos) x.cell.classList.toggle("lifted", x === p);
    paintViewerTone();
  }

  function centreStrip(smooth) {
    const b = V && V.thumbs[S.i];
    if (b) V.strip.scrollTo({ left: b.offsetLeft - V.strip.clientWidth / 2 + b.offsetWidth / 2, behavior: smooth && !REDUCED ? "smooth" : "auto" });
  }

  function paintViewerTone() {
    const p = cur(), key = p && p.key, zoomed = S.zoom.z > 1.01;
    V.backdrop.style.backgroundColor = tone(key, 6);
    // With the page locked, this is what shows where the scrollbar was.
    document.body.style.backgroundColor = tone(key, 6);
    for (const c of [V.top, V.bottom]) c.style.backgroundColor = zoomed ? tone(key, 6, 0.8) : "transparent";
  }

  // Lay the viewer out for the current phase:
  //   from     at the thumbnail's place, before the opening move
  //   to       in the frame
  //   swap     a new photo about to slide in from the side
  //   closing  heading back to the thumbnail
  function paintViewer() {
    const p = cur();
    if (!V || !p) return;
    const g = geom(p), ph = S.phase, fr = REDUCED ? null : S.from, Z = S.zoom;
    const flip = fr ? "translate(" + (fr.l + fr.w / 2 - (g.tx + g.tw / 2)).toFixed(1) + "px, " + (fr.t + fr.h / 2 - (g.ty + g.th / 2)).toFixed(1) + "px) scale(" + (fr.w / g.tw).toFixed(4) + ")" : null;
    let tf = "none", op = 1, tr = "transform .6s cubic-bezier(.16,1,.3,1), opacity .4s ease";
    if (ph === "from") { tr = "none"; if (flip) tf = flip; else { tf = "scale(.95)"; op = 0; } }
    else if (ph === "swap") { tr = "none"; tf = "translateX(" + S.dir * 40 + "px)"; op = 0; }
    else if (ph === "closing") {
      if (flip) { tf = flip; tr = "transform .5s cubic-bezier(.4,0,.2,1)"; }
      else { tf = "scale(.96)"; op = 0; tr = "transform .3s ease, opacity .3s ease"; }
    }
    if (REDUCED && tf !== "none") tf = "none";
    const shown = ph === "to" || ph === "swap";
    const zoomed = Z.z > 1.01;

    const b = V.box.style;
    b.left = g.tx.toFixed(1) + "px"; b.top = g.ty.toFixed(1) + "px";
    b.width = g.tw.toFixed(1) + "px"; b.height = g.th.toFixed(1) + "px";
    b.transition = tr; b.transform = tf; b.opacity = String(op);
    b.boxShadow = zoomed ? "none" : "0 30px 90px rgba(0,0,0,.45)";
    b.cursor = zoomed ? "grab" : "zoom-in";
    if (!zLive) {
      V.inner.style.transition = S.zAnim && !REDUCED ? "transform .32s cubic-bezier(.2,.8,.2,1)" : "none";
      V.inner.style.transform = "translate(" + Z.ox + "px, " + Z.oy + "px) scale(" + Z.z + ")";
    }
    V.backdrop.style.opacity = shown ? "1" : "0";
    for (const c of [V.top, V.bottom]) {
      c.style.opacity = shown ? "1" : "0";
      c.style.transition = "opacity " + (shown ? ".4s ease .15s" : ".25s ease") + ", background-color .3s ease";
      c.style.backdropFilter = c.style.webkitBackdropFilter = zoomed ? "blur(10px)" : "none";
    }
    const arrows = shown && !zoomed && filtered().length > 1;
    for (const a of [V.prev, V.next]) {
      a.style.top = Math.round(g.ty + g.th / 2 - 22) + "px";
      a.style.opacity = arrows ? "0.85" : "0";
      a.style.pointerEvents = arrows ? "auto" : "none";
    }
    V.zoomBtn.textContent = zoomed ? "Fit" : "Zoom";
    paintViewerTone();
  }

  function openAt(idx, from) {
    if (!filtered().length) return;
    if (V) endViewer();
    lastFocus = document.activeElement;
    S.open = true;
    S.i = Math.max(0, idx);
    S.phase = "from";
    S.from = rectOf(from);
    S.dir = 1;
    S.zoom = { z: 1, ox: 0, oy: 0 };
    S.zAnim = false;
    zLive = null;
    S.vw = document.documentElement.clientWidth;
    S.vh = window.innerHeight;
    V = buildViewer();
    showPhoto();
    paintViewer();
    centreStrip(false);
    document.documentElement.style.overflow = "hidden";
    window.addEventListener("wheel", onWheel, { passive: false });
    if (!TOUCH) V.close.focus({ preventScroll: true });
    toPhase("to");
  }

  function close() {
    if (!V || S.phase === "closing") return;
    const p = cur();
    zLive = null;
    S.from = S.zoom.z > 1 ? null : rectOf(p && p.cell);
    S.phase = "closing";
    paintViewer();
    closeT = setTimeout(endViewer, REDUCED ? 260 : 520);
  }

  function endViewer() {
    clearTimeout(closeT);
    clearTimeout(wheelT);
    if (!V) return;
    V.root.remove();
    V = null;
    S.open = false;
    S.phase = "idle";
    S.zoom = { z: 1, ox: 0, oy: 0 };
    zLive = null; gest = null; ptrs.clear();
    for (const p of S.photos) p.cell.classList.remove("lifted");
    document.documentElement.style.overflow = "";
    document.body.style.backgroundColor = "";
    window.removeEventListener("wheel", onWheel);
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
    heroKick();
  }

  function go(idx, dir) {
    if (!V || S.phase === "closing") return;
    zLive = null;
    S.i = idx;
    S.phase = "swap";
    S.dir = dir;
    S.zoom = { z: 1, ox: 0, oy: 0 };
    S.zAnim = false;
    showPhoto();
    paintViewer();
    centreStrip(true);
    toPhase("to");
  }

  function step(n) {
    const len = filtered().length || 1;
    go((S.i + n + len) % len, n);
  }

  // Gestures. One finger or the mouse: drag to pan when zoomed in, otherwise
  // swipe sideways for the next or previous photo. Two fingers: pinch.
  // Double-tap or double-click: zoom in on that spot, and back out.
  function vDown(e) {
    const t = e.target;
    if (t && t.closest && t.closest("[data-chrome]")) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const base = zLive || S.zoom;
    if (ptrs.size === 1) {
      gest = { t: "one", x0: e.clientX, y0: e.clientY, base: base, moved: false, touch: e.pointerType === "touch", inBox: !!(t && t.closest && t.closest("[data-vbox]")) };
    } else if (ptrs.size === 2) {
      const pts = Array.from(ptrs.values());
      gest = { t: "pinch", d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, base: base, mx: (pts[0].x + pts[1].x) / 2, my: (pts[0].y + pts[1].y) / 2 };
    }
  }

  function vMove(e) {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const gs = gest;
    if (!gs || S.phase === "closing") return;
    if (gs.t === "pinch" && ptrs.size >= 2) {
      const pts = Array.from(ptrs.values());
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
      const n = zoomAt(gs.base, (gs.base.z * d) / gs.d0, gs.mx, gs.my);
      liveZoom({ z: n.z, ox: n.ox + (mx - gs.mx), oy: n.oy + (my - gs.my) });
    } else if (gs.t === "one") {
      const dx = e.clientX - gs.x0, dy = e.clientY - gs.y0;
      if (Math.abs(dx) + Math.abs(dy) > 6) gs.moved = true;
      if (gs.base.z > 1 && gs.moved) liveZoom({ z: gs.base.z, ox: gs.base.ox + dx, oy: gs.base.oy + dy });
    }
  }

  function vUp(e) {
    const had = ptrs.has(e.pointerId);
    ptrs.delete(e.pointerId);
    const gs = gest;
    if (!gs || !had) return;
    if (gs.t === "pinch") {
      if (ptrs.size === 0) { gest = null; commitLive(); suppress = Date.now(); }
      return;
    }
    gest = null;
    const dx = e.clientX - gs.x0, dy = e.clientY - gs.y0;
    if (gs.base.z > 1) {
      if (gs.moved) { commitLive(); suppress = Date.now(); }
    } else if (gs.moved && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      suppress = Date.now();
      step(dx < 0 ? 1 : -1);
    } else if (!gs.moved && gs.touch && gs.inBox) {
      const now = Date.now(), lt = lastTap;
      if (lt && now - lt.t < 320 && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 30) {
        lastTap = null; dblAt = now; toggleZoomAt(e.clientX, e.clientY);
      } else lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
  }

  function onWheel(e) {
    if (!V || S.gateOpen || S.phase === "closing") return;
    const t = e.target;
    if (t && t.closest) {
      // Over the strip of thumbnails the wheel scrolls the strip.
      const row = t.closest("[data-striprow]");
      if (row) { e.preventDefault(); row.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY; return; }
      if (t.closest("[data-chrome]")) return;
    }
    e.preventDefault();
    const base = zLive || S.zoom;
    liveZoom(zoomAt(base, base.z * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), e.clientX, e.clientY));
    clearTimeout(wheelT);
    wheelT = setTimeout(commitLive, 140);
  }

  // ---- Keyboard ----
  function onKey(e) {
    if (S.gateOpen) { if (e.key === "Escape") closeGate(); return; }
    if (!V) { if (e.key === "Escape" && S.sel.size) clearSel(); return; }
    if (S.phase === "closing") return;
    const z = S.zoom.z;
    if (e.key === "Escape") { if (z > 1) setZoom(1, 0, 0, true); else close(); }
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "z" || e.key === "Z") toggleZoomCenter();
    else if (e.key === "+" || e.key === "=") zoomBy(1.5);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / 1.5);
    else if (e.key === "0") setZoom(1, 0, 0, true);
  }

  // ---- Boot ----
  function init() {
    if (hasAgreed()) S.agreed = true;
    try { S.tag = new URL(location.href).searchParams.get("tag") || null; } catch (e) {}

    paintContent();
    dragScroller(tagsEl);
    $("hero-prev").addEventListener("click", () => heroStep(-1));
    $("hero-next").addEventListener("click", () => heroStep(1));
    $("hero-view").addEventListener("click", openHero);

    // Measure on the next frame: re-laying out from inside the observer's own
    // callback is what triggers "ResizeObserver loop" warnings.
    if (window.ResizeObserver) new ResizeObserver(() => requestAnimationFrame(measure)).observe(grid);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", heroKick);
    measure();

    fetch("photos.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const list = d && Array.isArray(d.photos) ? d.photos : [];
        S.photos = list.map(normalize).filter((p) => p.full);
      })
      .catch(() => {})
      .then(() => {
        S.loaded = true;
        buildCells();
        buildTags();
        S.width = 0;
        measure();
        layout();
        buildHeroList();
        heroShow(0);
        schedule();
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
