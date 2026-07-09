# straybits.ca

Landing page for Straybits Corporation. One Cloudflare Worker serves static
assets from `public/` and handles `/api/*` in `src/worker.js`. Deployed to
straybits.ca + www.straybits.ca (custom domains) and straybits.jeffrey-clement.workers.dev.

## Deploying

- Push to `main` → GitHub Actions deploys (`.github/workflows/deploy.yml`).
  The workflow pins `wranglerVersion: "4.x"` — wrangler 3 cannot parse
  `wrangler.jsonc`; never remove the pin.
- Manual: `npm run deploy`. Local dev: `npm run dev` (put `CAPTCHA_SECRET` and
  `ADMIN_TOKEN` in `.dev.vars`; seed local D1 with
  `wrangler d1 execute straybits --local --file schema.sql`).
- Verify after deploy: `curl -s https://straybits.ca/api/challenge` returns JSON,
  and the homepage contains the new content.

## Design system (keep pages consistent)

Everything lives in `public/styles.css` — no framework, no build step.

- Colors: bg `#08090c`, accent orange `#ff8019` (from the logo; deep variant
  `#e85d04`), all via CSS vars in `:root`.
- Fonts: Space Grotesk (headings/body) + JetBrains Mono (eyebrows, buttons,
  terminal), loaded from Google Fonts.
- Voice: lowercase mono eyebrows like `// section-name`, shell-flavoured
  labels (`$ send message`, `./services`), wry copy. The company is
  deliberately vague: "small on purpose", not chasing clients.
- Motifs: drifting pixel "bits" canvas (`app.js`), pixel-grid backdrop,
  cards with tiny pixel-cluster corner decoration.

## Adding a page

1. Copy `public/privacy.html` as the skeleton — it has the nav, fonts,
   canvas, footer, and `<script src="/app.js" defer>` already wired.
   Use the `.prose` wrapper for text pages; `index.html` sections for fancy ones.
2. Keep `<canvas id="bits">` and the shared nav/footer identical across pages.
3. A file `public/foo.html` is served at `/foo` (assets `html_handling`
   auto-drops the extension). Update nav links in ALL html files (nav is
   duplicated per page — there's no templating).
4. `public/404.html` is the not-found page (`not_found_handling` in wrangler.jsonc).

## Adding a product

Products are cards in the `#products` section of `index.html`:

1. Duplicate the halmail `<a class="card product reveal">` block: `.num` holds
   the domain in brackets (`[halmail.org]`), then `h3`, one-paragraph pitch,
   and a `.card-cta` ("visit … →").
2. Keep the dashed "More compiling" placeholder card last; remove it only if
   the grid is full. `#products .cards` is a 2-col grid (1-col on mobile) —
   at 3+ real products consider `repeat(3, 1fr)` to match the services grid.

## Contact form / captcha (self-hosted, no third parties)

- `GET /api/challenge` issues `{challenge, ts, difficulty, sig}`; `sig` is
  HMAC-SHA256(`CAPTCHA_SECRET`, `challenge.ts.difficulty`).
- Browser (in `app.js`) brute-forces a nonce until `SHA-256(challenge.nonce)`
  has 15 leading zero bits (~1s, starts when the form scrolls into view).
- `POST /api/contact` verifies sig, age (2s–20min), proof, honeypot
  (`website` field must be empty — bots get a fake `{ok:true}`), then inserts
  into D1. The `challenge` column is UNIQUE = replay protection.
- Client and server must agree on the hash input format `${challenge}.${nonce}`
  and difficulty — change them in lockstep.

## Notifications & reading messages

- Successful submissions email jeff@erraticbits.ca via the `send_email`
  binding (best-effort, `ctx.waitUntil`; D1 is the source of truth).
- Sender is `notify@soohno.com`: Cloudflare refuses to enable Email Routing on
  straybits.ca/erraticbits.ca because their Fastmail MX records exist, so the
  spare zone soohno.com was routing-enabled to act as the sending domain. The
  destination must stay a verified Email Routing destination address on the
  Cloudflare account.
- `npm run messages` dumps recent submissions from D1, or
  `curl -H "Authorization: Bearer <ADMIN_TOKEN>" https://straybits.ca/api/messages`.

## Secrets & infrastructure

- Worker secrets (already set): `CAPTCHA_SECRET`, `ADMIN_TOKEN` (local copy in
  `.admin-token-KEEP-SAFE.txt`, gitignored). Rotate with `wrangler secret put`.
- GitHub repo secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
  (token lives in 1Password at `Private/Cloudflare`).
- D1 database `straybits` (id in wrangler.jsonc); schema in `schema.sql`.
- DO NOT enable Cloudflare Email Routing DNS on straybits.ca or
  erraticbits.ca — mail for those domains is on Fastmail and Cloudflare's
  routing DNS would break it.
