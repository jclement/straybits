/**
 * Straybits landing page worker.
 *
 * Static assets are served by the assets binding; this worker only handles
 * /api/* (run_worker_first in wrangler.jsonc).
 *
 * Contact-form spam defence (self-implemented, no third parties):
 *  - proof-of-work captcha: the server hands out an HMAC-signed challenge and
 *    the browser must find a nonce whose SHA-256 has DIFFICULTY leading zero
 *    bits before it can submit
 *  - each challenge is single-use (UNIQUE column in D1) and expires
 *  - honeypot field + minimum time-on-page
 */

const DIFFICULTY = 15; // leading zero bits; ~32k hashes on average, <1s in a browser
const CHALLENGE_MIN_AGE_MS = 2_000;
const CHALLENGE_MAX_AGE_MS = 20 * 60_000;

const enc = new TextEncoder();

const hex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

async function sha256Hex(message) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(message)));
}

function leadingZeroBits(hexStr) {
  let bits = 0;
  for (const ch of hexStr) {
    const v = parseInt(ch, 16);
    if (v === 0) {
      bits += 4;
      continue;
    }
    bits += Math.clz32(v) - 28;
    break;
  }
  return bits;
}

// Constant-time-ish comparison: compare digests of both values.
async function signaturesMatch(a, b) {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  return ha === hb;
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

async function issueChallenge(env) {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const challenge = hex(bytes.buffer);
  const ts = Date.now();
  const sig = await hmacHex(env.CAPTCHA_SECRET, `${challenge}.${ts}.${DIFFICULTY}`);
  return json({ challenge, ts, difficulty: DIFFICULTY, sig });
}

// Email notification via halmail (https://halmail.app) — straybits' own
// product. Sends a one-way no-reply notification (no from_address_id).
// Best-effort: D1 is the source of truth, so a failed send never fails the
// form submission. Requires the HALMAIL_API_KEY secret; the recipient must be
// a verified halmail recipient.
async function notify(env, { name, email, message }) {
  if (!env.HALMAIL_API_KEY || !env.NOTIFY_TO) return;

  const res = await fetch("https://halmail.app/api/v1/messages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.HALMAIL_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      to: [env.NOTIFY_TO],
      from_name: "straybits.ca contact form",
      subject: `[straybits.ca] Contact form: ${name.replace(/[\r\n\t]+/g, " ")}`,
      text: `Name: ${name}\nEmail: ${email}\n\n${message}\n`,
    }),
  });
  if (!res.ok) throw new Error(`halmail send failed: ${res.status} ${await res.text()}`);
}

async function handleContact(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid request body." }, 400);
  }

  const name = String(body.name ?? "").trim();
  const email = String(body.email ?? "").trim();
  const message = String(body.message ?? "").trim();
  const honeypot = String(body.website ?? "");
  const { challenge, ts, sig, nonce } = body;

  // Bots that fill every field get a cheerful lie.
  if (honeypot !== "") return json({ ok: true });

  if (!name || name.length > 200) return json({ ok: false, error: "Please provide a name." }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320)
    return json({ ok: false, error: "Please provide a valid email address." }, 400);
  if (!message || message.length > 5000)
    return json({ ok: false, error: "Please provide a message (max 5000 characters)." }, 400);

  // Captcha: signature, freshness, proof of work.
  if (typeof challenge !== "string" || typeof sig !== "string" || typeof nonce !== "string" || !Number.isFinite(ts))
    return json({ ok: false, error: "Captcha missing — please reload the page." }, 400);

  const expected = await hmacHex(env.CAPTCHA_SECRET, `${challenge}.${ts}.${DIFFICULTY}`);
  if (!(await signaturesMatch(expected, sig)))
    return json({ ok: false, error: "Captcha invalid — please reload the page." }, 400);

  const age = Date.now() - ts;
  if (age < CHALLENGE_MIN_AGE_MS || age > CHALLENGE_MAX_AGE_MS)
    return json({ ok: false, error: "Captcha expired — please reload the page." }, 400);

  const digest = await sha256Hex(`${challenge}.${nonce}`);
  if (leadingZeroBits(digest) < DIFFICULTY)
    return json({ ok: false, error: "Captcha not solved — please reload the page." }, 400);

  const ip = request.headers.get("cf-connecting-ip") ?? "";
  try {
    await env.DB.prepare(
      "INSERT INTO messages (name, email, message, ip, challenge) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
      .bind(name, email, message, ip, challenge)
      .run();
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      return json({ ok: false, error: "Captcha already used — please reload the page." }, 400);
    }
    throw err;
  }

  ctx.waitUntil(
    notify(env, { name, email, message }).catch((err) =>
      console.error("notify failed:", err),
    ),
  );

  return json({ ok: true });
}

async function handleMessages(request, env) {
  const auth = request.headers.get("authorization") ?? "";
  if (!env.ADMIN_TOKEN || !(await signaturesMatch(auth, `Bearer ${env.ADMIN_TOKEN}`)))
    return json({ ok: false, error: "Unauthorized." }, 401);

  const { results } = await env.DB.prepare(
    "SELECT id, created_at, name, email, message, ip FROM messages ORDER BY id DESC LIMIT 100",
  ).all();
  return json({ ok: true, messages: results });
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/challenge" && request.method === "GET") return issueChallenge(env);
    if (pathname === "/api/contact" && request.method === "POST") return handleContact(request, env, ctx);
    if (pathname === "/api/messages" && request.method === "GET") return handleMessages(request, env);
    if (pathname.startsWith("/api/")) return json({ ok: false, error: "Not found." }, 404);

    return env.ASSETS.fetch(request);
  },
};
