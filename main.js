/* CONTOUR — living topographic map: marching-squares iso-contours of an
   animated 2D noise field, drawn as nested elevation rings, plus motion layer. */
(() => {
  document.documentElement.classList.add('js'); // gate reveal-hiding on JS presence
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = matchMedia('(pointer: coarse)').matches;

  /* ---------- nav backdrop on scroll ---------- */
  const nav = document.getElementById('nav');
  if (nav) {
    const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 24);
    addEventListener('scroll', onScroll, { passive: true }); onScroll();
  }

  /* ---------- hero intro: CSS/compositor-driven, never rAF-dependent ---------- */
  const hero = document.querySelector('.hero');
  if (hero) {
    requestAnimationFrame(() => requestAnimationFrame(() => hero.classList.add('loaded')));
    setTimeout(() => hero.classList.add('loaded'), 400); // hard failsafe
  }

  // failsafe: if GSAP never arrives, reveal everything so nothing stays hidden
  const revealAll = () => document.querySelectorAll('.reveal').forEach(e => e.classList.add('is-in'));
  setTimeout(() => { if (!window.gsap) revealAll(); }, 2500);

  /* ==================================================================
     SIGNATURE TECHNIQUE — animated topographic contour lines
     ================================================================== */
  const canvas = document.getElementById('topo');
  const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;

  if (ctx) {
    // palette (matches styles.css)
    const MOSS = '47,58,38', BARK = '91,74,51', SIGNAL = '226,87,30', PAPER = '233,226,208';

    // --- value noise (3D) so the field morphs smoothly over time ---
    const hash3 = (x, y, z) => {
      const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
      return n - Math.floor(n);
    };
    const vnoise = (x, y, z) => {
      const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
      const xf = x - xi, yf = y - yi, zf = z - zi;
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
      const c000 = hash3(xi, yi, zi), c100 = hash3(xi + 1, yi, zi);
      const c010 = hash3(xi, yi + 1, zi), c110 = hash3(xi + 1, yi + 1, zi);
      const c001 = hash3(xi, yi, zi + 1), c101 = hash3(xi + 1, yi, zi + 1);
      const c011 = hash3(xi, yi + 1, zi + 1), c111 = hash3(xi + 1, yi + 1, zi + 1);
      const x00 = c000 + (c100 - c000) * u, x10 = c010 + (c110 - c010) * u;
      const x01 = c001 + (c101 - c001) * u, x11 = c011 + (c111 - c011) * u;
      const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
      return y0 + (y1 - y0) * w;
    };
    const fbm = (x, y, z) => {
      let val = 0, amp = 0.5, freq = 1;
      for (let i = 0; i < 3; i++) { val += amp * vnoise(x * freq, y * freq, z); freq *= 2; amp *= 0.5; }
      return val;
    };

    // drifting gaussian peaks + one basin → guarantees the iconic nested rings
    const peaks = [
      { amp: 0.66, sig: 0.25, x: 0.33, y: 0.44, rx: 0.10, ry: 0.06, sx: 0.9, sy: 0.7, px: 0.0, py: 1.3 },
      { amp: 0.52, sig: 0.30, x: 0.72, y: 0.58, rx: 0.12, ry: 0.09, sx: 0.6, sy: 1.0, px: 2.1, py: 0.4 },
      { amp: -0.44, sig: 0.33, x: 0.55, y: 0.22, rx: 0.13, ry: 0.07, sx: 0.7, sy: 0.9, px: 1.0, py: 3.0 }
    ];

    // levels (iso-values) → elevation rings; every 4th is an "index" contour
    const NS = 2.4;                 // noise frequency across the field
    const VMIN = 0.06, VMAX = 1.16; // iso-value span (matches the field's range)
    const EMIN = 380, EMAX = 3180;  // metres mapped onto that span
    const N = 17, HI = 8;           // level count + which one is the marked route
    const levels = [];
    for (let i = 0; i < N; i++) {
      const v = VMIN + (VMAX - VMIN) * i / (N - 1);
      levels.push({ v, major: i % 4 === 0, hi: i === HI, elev: elevOf(v) });
    }
    function elevOf(v) {
      return Math.round((EMIN + (v - VMIN) / (VMAX - VMIN) * (EMAX - EMIN)) / 20) * 20;
    }

    // grid + sizing
    let dpr = 1, cssW = 0, cssH = 0, cols = 0, rows = 0, sx = 0, sy = 0, field = new Float32Array(0), cx = 0;
    function resize() {
      const cap = coarse ? 1.25 : 1.5;
      dpr = Math.min(devicePixelRatio || 1, cap);
      cssW = canvas.clientWidth || innerWidth;
      cssH = canvas.clientHeight || innerHeight;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      const cell = coarse ? 34 : 22;          // grid resolution (coarser on mobile)
      cols = Math.max(8, Math.ceil(cssW / cell) + 1);
      rows = Math.max(8, Math.ceil(cssH / cell) + 1);
      sx = cssW / (cols - 1);
      sy = cssH / (rows - 1);
      field = new Float32Array(cols * rows);
      cx = ((rows >> 1) * cols) + (cols >> 1); // centre sample for the ELEV readout
    }
    addEventListener('resize', resize, { passive: true });
    resize();

    const aspect = () => cssW / cssH;
    function computeField(z, drift) {
      const asp = aspect();
      // resolve drifting peak centres once per frame
      for (let k = 0; k < peaks.length; k++) {
        const p = peaks[k];
        p.cxp = (p.x + p.rx * Math.sin(drift * p.sx + p.px)) * asp;
        p.cyp = p.y + p.ry * Math.cos(drift * p.sy + p.py);
        p.inv = 1 / (2 * p.sig * p.sig);
      }
      let i = 0;
      for (let r = 0; r < rows; r++) {
        const ny = r / (rows - 1);
        for (let c = 0; c < cols; c++, i++) {
          const ax = (c / (cols - 1)) * asp;
          let val = fbm(ax * NS, ny * NS, z);
          for (let k = 0; k < peaks.length; k++) {
            const p = peaks[k];
            const dx = ax - p.cxp, dy = ny - p.cyp;
            val += p.amp * Math.exp(-(dx * dx + dy * dy) * p.inv);
          }
          field[i] = val;
        }
      }
    }

    // marching squares for a single iso-level; strokes into the open path and
    // (when collecting) samples label anchors along index contours
    let cand = null, segN = 0;
    function marchLevel(L) {
      for (let r = 0; r < rows - 1; r++) {
        const o = r * cols;
        const y0 = r * sy, y1 = y0 + sy;
        for (let c = 0; c < cols - 1; c++) {
          const tl = field[o + c], tr = field[o + c + 1];
          const bl = field[o + c + cols], br = field[o + c + cols + 1];
          let idx = 0;
          if (tl > L) idx |= 8;
          if (tr > L) idx |= 4;
          if (br > L) idx |= 2;
          if (bl > L) idx |= 1;
          if (idx === 0 || idx === 15) continue;
          const x0 = c * sx, x1 = x0 + sx;
          // edge crossings (A top, B right, C bottom, D left)
          const ax = x0 + sx * (L - tl) / (tr - tl), ay = y0;
          const bx = x1, by = y0 + sy * (L - tr) / (br - tr);
          const cx2 = x0 + sx * (L - bl) / (br - bl), cy2 = y1;
          const dx = x0, dy = y0 + sy * (L - tl) / (bl - tl);
          switch (idx) {
            case 1: case 14: seg(dx, dy, cx2, cy2); break;
            case 2: case 13: seg(cx2, cy2, bx, by); break;
            case 3: case 12: seg(dx, dy, bx, by); break;
            case 4: case 11: seg(ax, ay, bx, by); break;
            case 6: case 9:  seg(ax, ay, cx2, cy2); break;
            case 7: case 8:  seg(ax, ay, dx, dy); break;
            case 5:  seg(ax, ay, bx, by); seg(cx2, cy2, dx, dy); break;
            case 10: seg(ax, ay, dx, dy); seg(cx2, cy2, bx, by); break;
          }
        }
      }
    }
    function seg(a, b, c, d) {
      ctx.moveTo(a, b); ctx.lineTo(c, d);
      if (cand && (segN++ & 3) === 0) {
        cand.push(a * 0.5 + c * 0.5, b * 0.5 + d * 0.5, Math.atan2(d - b, c - a));
      }
    }

    function render(z, drift, off) {
      off = off || 0;
      computeField(z, drift);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';

      // minor contours
      ctx.strokeStyle = `rgba(${BARK},0.30)`; ctx.lineWidth = 1;
      ctx.beginPath();
      for (const lv of levels) if (!lv.major && !lv.hi) marchLevel(lv.v + off);
      ctx.stroke();

      // index (major) contours — collect label anchors as we go
      const anchors = []; const texts = [];
      ctx.strokeStyle = `rgba(${MOSS},0.52)`; ctx.lineWidth = 1.7;
      for (const lv of levels) {
        if (!lv.major) continue;
        cand = []; segN = 0;
        ctx.beginPath();
        marchLevel(lv.v + off);
        ctx.stroke();
        for (let j = 0; j < cand.length; j += 3) { anchors.push(cand[j], cand[j + 1], cand[j + 2]); texts.push(lv.elev); }
      }
      cand = null;

      // the marked route contour, in signal orange
      ctx.strokeStyle = `rgba(${SIGNAL},0.85)`; ctx.lineWidth = 2.3;
      ctx.beginPath(); marchLevel(levels[HI].v + off); ctx.stroke();

      // elevation labels — greedy spread so they never crowd
      drawLabels(anchors, texts);
    }

    const placed = [];
    function drawLabels(anchors, texts) {
      placed.length = 0;
      const MIN = 118, MAX = 9, edge = 46;
      ctx.font = '700 10px "Space Mono", ui-monospace, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let j = 0; j < anchors.length && placed.length < MAX; j += 3) {
        const x = anchors[j], y = anchors[j + 1];
        let ang = anchors[j + 2];
        if (x < edge || x > cssW - edge || y < edge + 40 || y > cssH - edge) continue;
        let ok = true;
        for (let p = 0; p < placed.length; p += 2) {
          const ddx = x - placed[p], ddy = y - placed[p + 1];
          if (ddx * ddx + ddy * ddy < MIN * MIN) { ok = false; break; }
        }
        if (!ok) continue;
        placed.push(x, y);
        if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
        const txt = String(texts[j / 3]);
        ctx.save();
        ctx.translate(x, y); ctx.rotate(ang);
        ctx.lineWidth = 4; ctx.strokeStyle = `rgba(${PAPER},0.92)`;
        ctx.strokeText(txt, 0, 0);           // paper halo = the classic "gap in the line"
        ctx.fillStyle = `rgba(${MOSS},0.9)`;
        ctx.fillText(txt, 0, 0);
        ctx.restore();
      }
    }

    // ---- live ELEV / LAT / LONG readout, tied to the field ----
    const elElev = document.getElementById('ro-elev');
    const elLat = document.getElementById('ro-lat');
    const elLong = document.getElementById('ro-long');
    let roAcc = 0, elevShown = 2340;

    // ---- drive loop ----
    if (reduce) {
      render(3.4, 1.2);                       // one static, well-formed frame
    } else {
      const start = performance.now();
      let last = 0, skip = 0;
      const step = (now) => {
        const el = now - start;
        // throttle to ~40fps on coarse pointers to keep it smooth on phones
        if (coarse && ++skip % 2 === 0) { requestAnimationFrame(step); return; }
        const z = el * 0.00011;               // morph through the noise volume
        const drift = el * 0.00028;           // slow lateral drift of the peaks
        const breathe = 0.03 * Math.sin(el * 0.00022); // rings expand/contract
        render(z, drift, breathe);
        // readout, throttled so the DOM never thrashes
        roAcc += now - (last || now); last = now;
        if (roAcc > 140) {
          roAcc = 0;
          const target = elevOf(clamp(field[cx], VMIN, VMAX));
          elevShown += (target - elevShown) * 0.2;
          if (elElev) elElev.textContent = Math.round(elevShown);
          const tsec = el / 1000;
          if (elLat) elLat.textContent = (46.5197 + 0.0016 * Math.sin(tsec * 0.25)).toFixed(4);
          if (elLong) elLong.textContent = (7.9622 + 0.0021 * Math.cos(tsec * 0.19)).toFixed(4);
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
    function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  }

  /* ---------- count-up numbers ---------- */
  const nums = document.querySelectorAll('[data-count]');
  const animateCount = (el) => {
    const target = parseFloat(el.dataset.count);
    if (isNaN(target)) return;
    const comma = el.dataset.comma === '1';
    const render = (v) => comma ? Math.round(v).toLocaleString('en-US') : Math.round(v).toString();
    if (reduce) { el.textContent = render(target); return; }
    const dur = 1500, start = performance.now();
    const step = (now) => {
      const prog = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - prog, 3);
      el.textContent = render(target * e);
      if (prog < 1) requestAnimationFrame(step); else el.textContent = render(target);
    };
    requestAnimationFrame(step);
  };
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(en => { if (en.isIntersecting) { animateCount(en.target); io.unobserve(en.target); } });
    }, { threshold: 0.5 });
    nums.forEach(n => io.observe(n));
  } else {
    nums.forEach(animateCount);
  }

  /* ---------- custom crosshair cursor ---------- */
  if (!reduce && matchMedia('(pointer:fine)').matches) {
    const cur = document.querySelector('.cursor');
    if (cur) {
      const p = { x: innerWidth / 2, y: innerHeight / 2, tx: innerWidth / 2, ty: innerHeight / 2 };
      addEventListener('pointermove', e => { p.tx = e.clientX; p.ty = e.clientY; }, { passive: true });
      (function loop() {
        p.x += (p.tx - p.x) * 0.2; p.y += (p.ty - p.y) * 0.2;
        cur.style.transform = `translate(${p.x}px,${p.y}px) translate(-50%,-50%)`;
        requestAnimationFrame(loop);
      })();
      document.querySelectorAll('a,button,.route,.kit-item,.cta').forEach(el => {
        el.addEventListener('pointerenter', () => cur.classList.add('hot'));
        el.addEventListener('pointerleave', () => cur.classList.remove('hot'));
      });
    }
  }

  /* ---------- GSAP motion layer ---------- */
  window.addEventListener('load', () => {
    if (!window.gsap || !window.ScrollTrigger) { revealAll(); return; }
    gsap.registerPlugin(ScrollTrigger);

    gsap.utils.toArray('.reveal').forEach(el => {
      if (el.closest('.hero')) return; // hero reveals are the CSS .loaded intro
      ScrollTrigger.create({ trigger: el, start: 'top 88%', onEnter: () => el.classList.add('is-in') });
    });
  });
})();
