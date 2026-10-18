# CareerConnect SA

The website (`public/index.html`) plus the small server pieces it needs:

- **Email / SMS confirmation codes (OTP)** at sign-up: `/api/otp/send`, `/api/otp/verify`
- **AI document reading** `/api/extract` (server side only, in `server.js`; the page is not wired to it yet)

It runs in two ways, using the same code logic:

| Where | How |
|---|---|
| **Netlify** (GitHub → Netlify) | `netlify/functions/*` handle the codes, `netlify.toml` tells Netlify where things are |
| **Your own computer** or any Node host | `server.js` (Express), started with `npm start` |

## Deploy on Netlify (GitHub → Netlify)

1. **Put these files in your GitHub repository** so that `netlify.toml`, `package.json`, `otp.js`, `senders.js`, the `netlify` folder and the `public` folder are at the top level of the repo. The old root `index.html` is no longer used; delete it. **Never upload `.env`** (the included `.gitignore` skips it). If real keys ever reached GitHub, delete them in your provider's dashboard and create new ones.
2. **Add your settings in Netlify:** Site configuration → Environment variables (menu names may differ slightly). Add:
   - `OTP_SECRET`: a long random value. Make one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `NODE_ENV` = `production`
   - Email: `RESEND_API_KEY` and `EMAIL_FROM`
   - SMS: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM` (or `TWILIO_MESSAGING_SERVICE_SID`)
3. **Deploy again.** Pushing to GitHub does this. After adding or changing variables, also use Deploys → Trigger deploy.
4. **Check it:** open `https://YOURSITE.netlify.app/api/health`. You want `otpSecretSet: true`, `storage: "ok"`, and `provider` next to the channel you set up.
5. **Try a sign-up** on your site.

**Testing before you have email/SMS keys:** set `NODE_ENV` to `development` in Netlify. Codes are then written to the function log (Netlify → Logs → Functions), not sent and not shown on the website. Switch back to `production` afterwards.

How it fits Netlify: the codes are kept in Netlify Blobs (built in, no extra account), and Netlify itself limits how often one IP can call the endpoints (5 sends per 3 minutes, 20 checks per minute).

## Run on your computer

1. Install Node.js 20.12 or newer. In this folder run `npm install`.
2. Optional: copy `.env.example` to `.env` and set `OTP_SECRET`.
3. `npm start`, then open http://localhost:3000 (not the `index.html` file).
4. With no email/SMS keys the code is printed in the terminal. `npm test` runs the automated tests.

`OTP_DEMO_MODE = true` in `public/index.html` previews the screens with no server at all (the code is shown on screen: not secure, previews only).

## Sending real codes

- **SMS:** Twilio. Trial accounts can usually only text numbers you've verified, and sender rules differ by country, so check Twilio's South Africa guidance and geographic permissions.
- **Email:** Resend. `EMAIL_FROM` must use a domain you've verified in Resend (Resend's shared test sender only emails your own account address).
- **Another provider** (e.g. a South African SMS gateway): add one function in `senders.js`.

## "We couldn't send your code"

The visitor only sees that generic message. The real reason is in the logs: the terminal running `npm start`, or on Netlify, Logs → Functions (look for `[otp] sending failed:`). Also check `/api/health`. Common causes: `NODE_ENV=production` with no provider keys; placeholder keys left in; Resend domain not verified; Twilio trial number not verified; variables changed but not redeployed.

If the page says the service "wasn't found", the `netlify` folder or `netlify.toml` isn't in the repo yet, or the site hasn't been redeployed.

## How the codes work

- 6 digits, valid for 10 minutes, usable once. 5 wrong guesses destroy the code. One new code per minute and 5 per hour for each address/number.
- Parallel requests can't get free guesses or trigger extra messages: every change is a compare-and-set write, and the visitor is only told "right" or "wrong" after their attempt was counted.
- Codes and addresses are stored only as keyed hashes. Codes are never written to logs in production.
- After a correct code the server returns a signed token. `checkToken()` in `otp.js` lets a future server-side sign-up confirm an email/number really was verified.

## Before going live

- **Accounts must move to a server database.** Today accounts, passwords and the "confirmed" flag live in each visitor's own browser, so the code check only stops honest users (someone editing their own browser could skip it), passwords are stored in plain text there, and an employer on one device can't see applications made on another. Production needs server-side accounts with hashed passwords (argon2 or bcrypt).
- Small leftover records (one per address/number, no codes inside) stay in Blobs; they can be cleared from the Netlify Blobs page.
- Consider a CAPTCHA on sign-up to limit SMS-cost abuse, and add a privacy notice covering phone numbers (POPIA).
