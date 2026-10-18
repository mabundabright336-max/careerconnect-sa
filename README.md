# CareerConnect SA

The website (`public/index.html`) plus optional server pieces. Sign-up confirmation can work three ways. Pick one with `VERIFY_METHOD` near the top of the page's script:

| `VERIFY_METHOD` | What the user gets | Needs |
|---|---|---|
| `'firebase'` (default) | **SMS:** a 6-digit code. **Email:** a verification link. | A free Firebase project. No server, works on Netlify or any static host. |
| `'server'` | **SMS and email:** 6-digit codes sent by this project's own server (Twilio / Resend). | Netlify Functions (or `server.js`) plus provider accounts. |
| `'demo'` | Preview of the screens only. The code is shown on the page (not secure). | Nothing. |

## Use Firebase for SMS and email confirmation

**What users see**
- **SMS:** Firebase texts a 6-digit code. The user types it into the page.
- **Email:** Firebase emails a verification **link** (Firebase doesn't send typed codes by email). The user opens the link, returns to the page and presses "I've verified my email". The page also notices on its own after a few seconds.
- The account is only created after this step succeeds.

**Set it up (about 15 minutes)**
1. Go to console.firebase.google.com and add a project.
2. Project settings → General → Your apps → add a **Web app** (the `</>` icon). Copy the four values (`apiKey`, `authDomain`, `projectId`, `appId`) into `FIREBASE_CONFIG` in the `<script type="module">` block at the bottom of `public/index.html`. These values are meant to be public.
3. Authentication → Get started → Sign-in method: enable **Phone** and **Email/Password**.
4. Authentication → Settings → **Authorized domains**: add your Netlify address (for example `yoursite.netlify.app`) and any custom domain.
5. **SMS to South Africa:** Authentication → Settings → **SMS region policy**: allow South Africa. New Firebase projects block every region by default, so until you do, sending fails with "operation not allowed". Real SMS may also need the project switched to the pay-as-you-go (Blaze) plan. Check your Firebase console and pricing page for the current rules and costs.
6. **Test without sending real SMS:** Sign-in method → Phone → **Phone numbers for testing**. Add a made-up number such as `+27 82 000 0001` with the code `123456`, then use that number on your site. No SMS is sent and nothing is charged.
7. **Email wording:** Authentication → Templates → "Email address verification" (sender name, subject, text). By default the email comes from a Firebase address and can land in spam, so tell users to check spam. Firebase also lets you use your own sender domain.
8. Push to GitHub. Netlify redeploys and it works.

**Good to know**
- Email sign-ups create a Firebase user with the password the person chose (Firebase stores it hashed). The page still uses its own login for now.
- Each new account saves a `firebaseUid` linking it to its Firebase user.
- Firebase proves the email or number belongs to the person at sign-up. Accounts still live in each visitor's browser, so someone editing their own browser could skip the step. To enforce it, move login and accounts to Firebase Authentication plus a database.

## Option: your own codes on Netlify (`VERIFY_METHOD = 'server'`)

Skip this whole part if you use Firebase.


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

`VERIFY_METHOD = 'demo'` in `public/index.html` previews the screens with no server at all (the code is shown on screen: not secure, previews only).

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
