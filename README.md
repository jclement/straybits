# straybits.ca

Landing page for Straybits Corporation, served by a single Cloudflare Worker.

- **Static site** in `public/` (dark landing page, privacy policy, 404)
- **Worker** in `src/worker.js` handles `/api/*`:
  - `GET /api/challenge` — issues an HMAC-signed proof-of-work captcha challenge
  - `POST /api/contact` — validates the captcha (signature, freshness, single-use, PoW), honeypot, and timing, then stores the message in D1
  - `GET /api/messages` — lists recent submissions (requires `Authorization: Bearer $ADMIN_TOKEN`)

## Anti-spam captcha (self-hosted)

No third-party captcha. The browser fetches a challenge signed with `CAPTCHA_SECRET`,
then brute-forces a nonce until `SHA-256(challenge.nonce)` has 15 leading zero bits
(~32k hashes, well under a second, runs invisibly while you type). The server verifies
the signature, the proof, freshness (2s–20min old), and single-use (UNIQUE column in D1).
Plus a honeypot field. Cheap for a human, annoying at bot scale.

## Reading contact messages

```sh
npm run messages
# or
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://straybits.ca/api/messages
```

## Deploys

Pushes to `main` deploy via GitHub Actions (`.github/workflows/deploy.yml`).
Repo secrets required:

- `CLOUDFLARE_API_TOKEN` — API token with the **Edit Cloudflare Workers** template + D1 edit
- `CLOUDFLARE_ACCOUNT_ID`

Manual deploy: `npm install && npm run deploy`.

## One-time setup (already done)

```sh
wrangler d1 create straybits                      # ID goes in wrangler.jsonc
wrangler d1 execute straybits --remote --file schema.sql
wrangler secret put CAPTCHA_SECRET                # any long random string
wrangler secret put ADMIN_TOKEN                   # bearer token for /api/messages
```

## Domains & notifications

Deployed to `straybits.ca` and `www.straybits.ca` as Worker custom domains
(`routes` in wrangler.jsonc). Contact submissions also email jeff@erraticbits.ca
via the `send_email` binding — sent from `notify@soohno.com`, since Email
Routing can't be enabled on domains whose MX is Fastmail (see CLAUDE.md).

## Local dev

```sh
npm install
wrangler d1 execute straybits --local --file schema.sql
npm run dev
```

Put dev secrets in `.dev.vars` (gitignored):

```
CAPTCHA_SECRET=dev-secret
ADMIN_TOKEN=dev-token
```
