# CareerConnect SA — server

Serves the website (`public/index.html`) and provides:

- **Email / SMS confirmation codes (OTP)** for sign-up: `POST /api/otp/send`, `POST /api/otp/verify`
- **AI document reading**: `POST /api/extract` (the server side is ready; the page is not wired to it in the current `index.html`)

## Run it

1. Install Node.js 20.12 or newer (nodejs.org).
2. In this folder run `npm install`.
3. Copy `.env.example` to `.env` and set `OTP_SECRET` to a long random value:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
4. `npm start`, then open http://localhost:3000
5. `npm test` runs the automated tests.

**No SMS/email account yet?** Leave the provider settings empty. While `NODE_ENV` is not `production`, each code is printed in the terminal where the server runs, and the page shows a "Developer mode" note. Codes are never sent to the browser.

**Just want to look at the screens, without the server?** In `public/index.html` set `OTP_DEMO_MODE = true`. The code is then shown on screen. This is for previewing only and is not secure.

## Sending real codes

Set the variables in `.env` (see `.env.example`):

- **SMS:** Twilio (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID`). Trial accounts can usually only text numbers you have verified, and sender rules differ by country, so check Twilio's South Africa guidance.
- **Email:** Resend (`RESEND_API_KEY`, `EMAIL_FROM`). The sending domain must be verified in your Resend account.
- **Another provider** (for example a South African SMS gateway): add one function in `senders.js`.

## Putting it online (GitHub is not enough)

**GitHub Pages only serves static files, so it cannot send codes.** The Node server in this folder has to run on a host that runs Node apps (Render, Railway, Fly.io and similar; check what each costs today). GitHub is still the right place for the code.

**Option A (recommended): host everything on the Node host**
1. Put this whole folder in a GitHub repository. **Never upload `.env`** (the included `.gitignore` already skips it). If real keys were ever pushed to GitHub, delete them from your provider's dashboard and create new ones.
2. On the host, create a new "Web Service" from that repository. Build command: `npm install`. Start command: `npm start`. Use Node 20.12 or newer.
3. Add the settings from `.env.example` in the host's **Environment** page: `OTP_SECRET`, `NODE_ENV=production`, plus your email and/or SMS keys.
4. Open the address the host gives you. The site, sign-up and codes all work from there. You can stop using the GitHub Pages address.

**Option B: keep the page on GitHub Pages, host only the server elsewhere**
1. Deploy the server as in Option A, and also set `ALLOWED_ORIGIN` to your Pages address (for example `https://yourname.github.io`).
2. In `public/index.html`, set `API_BASE` to the server's address (for example `https://careerconnect.onrender.com`, with no slash at the end), then push the change.

**In production mode real keys are required.** With `NODE_ENV=production` and no email/SMS keys, sending fails with "We couldn't send your code". For a short test before you have keys, set `NODE_ENV` to `development` on the host: the codes then appear in the host's log page, not on the website. Switch back to `production` afterwards.

## "We couldn't send your code"

The page shows that generic message whenever sending fails. **The real reason is printed in the terminal where `npm start` is running**, on a line starting `[otp] sending failed:`. When the server starts it also tells you how codes will go out (for real, printed in the terminal, or not available). You can check the same thing at http://localhost:3000/api/health.

Common causes:

- `NODE_ENV=production` is set but no email/SMS provider keys are filled in. Either add the keys or remove that line while testing.
- Placeholder keys left in `.env` (for example `TWILIO_FROM=+1xxxxxxxxxx`). Delete the lines you aren't using, so codes print in the terminal instead.
- **Resend:** `EMAIL_FROM` must use a domain you verified in Resend. Resend's shared test sender can only email your own account address.
- **Twilio trial:** it can only text numbers you've verified in your Twilio account. Also make sure sending to South Africa is allowed in its geographic permissions, and that `TWILIO_FROM` is a number or sender your account can use.
- You changed `.env` but didn't restart. Stop the server (Ctrl+C) and run `npm start` again.

## How the codes work

- 6 digits, valid for 10 minutes, usable once.
- 5 wrong guesses and the code is destroyed. One new code per minute and 5 per hour for each address/number, plus per-IP limits.
- Codes are stored only as hashes (HMAC) and never written to logs in production.
- After a correct code the server returns a signed token. `checkToken()` in `otp.js` lets a future server-side sign-up confirm that an email/number really was verified.

## Before going live

- **Accounts must move to a server database.** Today accounts, passwords and the "confirmed" flag live in the visitor's browser storage, so the code check only stops honest users: someone editing their own browser could skip it. Passwords are stored in plain text there too. Production needs server-side accounts with hashed passwords (argon2 or bcrypt).
- Serve over HTTPS and set `NODE_ENV=production` (then sending fails unless a provider is configured, instead of falling back to the terminal).
- The code store and rate limits are in memory: they reset on restart and aren't shared between servers. Use Redis or a database if you run more than one.
- Consider a CAPTCHA on sign-up to limit SMS-cost abuse, and add a privacy notice covering phone numbers (POPIA).
