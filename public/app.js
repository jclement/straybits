/* straybits.ca — particles, terminal, and a self-hosted proof-of-work captcha */

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ── drifting bits ─────────────────────────────────────────────────────── */

(() => {
  const canvas = document.getElementById("bits");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let bits = [];

  function resize() {
    canvas.width = window.innerWidth * devicePixelRatio;
    canvas.height = window.innerHeight * devicePixelRatio;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    const count = Math.min(90, Math.floor(window.innerWidth / 16));
    bits = Array.from({ length: count }, () => spawn(true));
  }

  function spawn(anywhere) {
    return {
      x: Math.random() * window.innerWidth,
      y: anywhere ? Math.random() * window.innerHeight : window.innerHeight + 8,
      size: 1.5 + Math.random() * 3.5,
      vy: 0.1 + Math.random() * 0.35,
      vx: (Math.random() - 0.3) * 0.08,
      alpha: 0.04 + Math.random() * 0.22,
      flicker: Math.random() < 0.18,
      phase: Math.random() * Math.PI * 2,
    };
  }

  let t = 0;
  function frame() {
    t += 0.016;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (let i = 0; i < bits.length; i++) {
      const b = bits[i];
      b.y -= b.vy;
      b.x += b.vx;
      if (b.y < -10 || b.x < -10 || b.x > window.innerWidth + 10) bits[i] = spawn(false);
      const a = b.flicker ? b.alpha * (0.4 + 0.6 * Math.abs(Math.sin(t * 3 + b.phase))) : b.alpha;
      ctx.fillStyle = `rgba(255, 128, 25, ${a})`;
      ctx.fillRect(b.x, b.y, b.size, b.size);
    }
    requestAnimationFrame(frame);
  }

  resize();
  window.addEventListener("resize", resize);
  if (reducedMotion) {
    // one static frame
    for (const b of bits) {
      ctx.fillStyle = `rgba(255, 128, 25, ${b.alpha})`;
      ctx.fillRect(b.x, b.y, b.size, b.size);
    }
  } else {
    requestAnimationFrame(frame);
  }
})();

/* ── terminal ──────────────────────────────────────────────────────────── */

(() => {
  const term = document.getElementById("term");
  if (!term) return;

  const lines = [
    { html: '<span class="prompt">jsc@straybits ~ %</span> straybits --status', type: true },
    { html: '  consulting    <span class="ok">●</span> available <span class="dim">(sparingly)</span>' },
    { html: '  development   <span class="ok">●</span> shipping' },
    { html: '  security      <span class="ok">●</span> watching' },
    { html: '  new clients   <span class="dim">● by referral, mostly</span>' },
    { html: '<span class="prompt">jsc@straybits ~ %</span> ', cursor: true, type: true },
  ];

  if (reducedMotion) {
    term.innerHTML =
      lines.map((l) => l.html).join("\n") + '<span class="cursor"></span>';
    return;
  }

  let li = 0;
  function nextLine() {
    if (li >= lines.length) return;
    const line = lines[li++];
    const div = document.createElement("div");
    term.appendChild(div);
    if (!line.type) {
      div.innerHTML = line.html;
      setTimeout(nextLine, 120);
      return;
    }
    // type it out; safe because the HTML is our own literal above
    const tmp = document.createElement("div");
    tmp.innerHTML = line.html;
    const text = tmp.textContent;
    let ci = 0;
    const tick = setInterval(() => {
      ci++;
      div.textContent = text.slice(0, ci);
      if (ci >= text.length) {
        clearInterval(tick);
        div.innerHTML = line.html + (line.cursor ? '<span class="cursor"></span>' : "");
        setTimeout(nextLine, 250);
      }
    }, 28);
  }
  setTimeout(nextLine, 600);
})();

/* ── reveal on scroll ──────────────────────────────────────────────────── */

(() => {
  const els = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window) || reducedMotion) {
    els.forEach((el) => el.classList.add("in"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      }
    },
    { threshold: 0.12 },
  );
  els.forEach((el) => io.observe(el));
})();

/* ── proof-of-work captcha + contact form ──────────────────────────────── */

(() => {
  const form = document.getElementById("contact-form");
  if (!form) return;

  const statusEl = document.getElementById("captcha-status");
  const statusText = document.getElementById("captcha-text");
  const submitBtn = document.getElementById("cf-submit");
  const resultEl = document.getElementById("form-result");

  let solution = null; // { challenge, ts, sig, nonce }
  let solving = false;

  const enc = new TextEncoder();
  async function sha256Hex(msg) {
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(msg));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function leadingZeroBits(hexStr) {
    let bits = 0;
    for (const ch of hexStr) {
      const v = parseInt(ch, 16);
      if (v === 0) { bits += 4; continue; }
      bits += Math.clz32(v) - 28;
      break;
    }
    return bits;
  }

  function setStatus(mode, text) {
    statusEl.className = `captcha-status ${mode}`;
    statusText.textContent = text;
  }

  async function solve() {
    if (solving || solution) return;
    solving = true;
    submitBtn.disabled = true;
    try {
      setStatus("solving", "proof-of-work: fetching challenge…");
      const res = await fetch("/api/challenge");
      const { challenge, ts, difficulty, sig } = await res.json();

      setStatus("solving", "proof-of-work: solving…");
      let nonce = 0;
      const started = performance.now();
      for (;;) {
        const digest = await sha256Hex(`${challenge}.${nonce}`);
        if (leadingZeroBits(digest) >= difficulty) break;
        nonce++;
        if (nonce % 500 === 0) {
          setStatus("solving", `proof-of-work: solving… ${nonce.toLocaleString()} hashes`);
          await new Promise((r) => setTimeout(r, 0)); // let the UI breathe
        }
      }
      const ms = Math.round(performance.now() - started);
      solution = { challenge, ts, sig, nonce: String(nonce) };
      setStatus("solved", `proof-of-work: verified (${(nonce + 1).toLocaleString()} hashes, ${ms}ms)`);
      submitBtn.disabled = false;
    } catch {
      setStatus("", "proof-of-work: failed — reload to retry");
    } finally {
      solving = false;
    }
  }

  // Start solving once the form is nearly in view (or on first focus).
  submitBtn.disabled = true;
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          solve();
        }
      },
      { rootMargin: "300px" },
    );
    io.observe(form);
  } else {
    solve();
  }
  form.addEventListener("focusin", solve, { once: true });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    resultEl.className = "form-result";
    resultEl.textContent = "";

    if (!form.reportValidity()) return;
    if (!solution) { solve(); return; }

    submitBtn.disabled = true;
    submitBtn.textContent = "$ sending…";
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: document.getElementById("cf-name").value,
          email: document.getElementById("cf-email").value,
          message: document.getElementById("cf-message").value,
          website: document.getElementById("cf-website").value,
          ...solution,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        resultEl.className = "form-result ok";
        resultEl.textContent = "✓ message received — thanks, we'll be in touch.";
        form.reset();
        submitBtn.textContent = "$ send message";
        solution = null;
        setStatus("", "proof-of-work: idle");
        solve(); // pre-solve a fresh challenge in case they send another
      } else {
        throw new Error(data.error || "Something went wrong.");
      }
    } catch (err) {
      resultEl.className = "form-result err";
      resultEl.textContent = `✗ ${err.message || "Something went wrong — please try again."}`;
      submitBtn.textContent = "$ send message";
      submitBtn.disabled = false;
      // a used/expired challenge won't work twice; get a fresh one
      solution = null;
      solve();
    }
  });
})();

/* ── misc ──────────────────────────────────────────────────────────────── */

const yearEl = document.getElementById("year");
if (yearEl) yearEl.textContent = new Date().getFullYear();
