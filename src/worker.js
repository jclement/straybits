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

import { EmailMessage } from "cloudflare:email";

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

// Email notification via the send_email binding. Best-effort: D1 is the
// source of truth, so a failed send never fails the form submission.
async function notify(env, { name, email, message }) {
  if (!env.NOTIFY || !env.NOTIFY_FROM || !env.NOTIFY_TO) return;

  const headerSafe = (s) => s.replace(/[\r\n\t]+/g, " ");
  // RFC 2047 encode if the subject strays outside ASCII
  const subjectRaw = `[straybits.ca] Contact form: ${headerSafe(name)}`;
  const subject = /^[\x20-\x7e]*$/.test(subjectRaw)
    ? subjectRaw
    : `=?utf-8?B?${btoa(String.fromCharCode(...enc.encode(subjectRaw)))}?=`;

  const body = `Name: ${name}\nEmail: ${email}\n\n${message}\n`;
  const bodyB64 = btoa(String.fromCharCode(...enc.encode(body)))
    .match(/.{1,76}/g)
    .join("\r\n");

  const raw =
    `From: straybits.ca contact form <${env.NOTIFY_FROM}>\r\n` +
    `To: <${env.NOTIFY_TO}>\r\n` +
    `Reply-To: ${headerSafe(name)} <${email}>\r\n` +
    `Subject: ${subject}\r\n` +
    `Message-ID: <${crypto.randomUUID()}@straybits.ca>\r\n` +
    `Date: ${new Date().toUTCString()}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `\r\n` +
    bodyB64 + `\r\n`;

  await env.NOTIFY.send(new EmailMessage(env.NOTIFY_FROM, env.NOTIFY_TO, raw));
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
