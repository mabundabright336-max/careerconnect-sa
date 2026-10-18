# CareerConnect SA

The website (`public/index.html`) plus optional server pieces. Sign-up is confirmed **by email**. Choose how with `VERIFY_METHOD` near the top of the page's script:

| `VERIFY_METHOD` | What the user gets | Needs |
|---|---|---|
| `'firebase'` (default) | An email with a verification **link** to open. | A free Firebase project. No server, works on Netlify or any static host. |
| `'server'` | An email with a 6-digit **code** sent by this project's own server (Resend). | Netlify Functions (or `server.js`) plus a Resend account. |
| `'demo'` | Preview of the screens only. The code is shown on the page (not secure). | Nothing. |

SMS confirmation has been removed from the sign-up. The phone number is still collected as contact information (a mobile number for individuals, a landline for companies).

## Use Firebase for email confirmation

**What users see:** Firebase emails a verification link. The user opens it, returns to the page and presses "I've verified my email" (the page also notices on its own after a few seconds). The account is only created after that.

**Set it up (about 10 minutes, free)**
1. Go to console.firebase.google.com and add a project.
2. Project settings → General → Your apps → add a **Web app** (the `</>` icon). Copy `apiKey`, `authDomain`, `projectId` and `appId` into `FIREBASE_CONFIG` in the `<script type="module">` block at the bottom of `public/index.html`. These values are meant to be public.
3. Authentication → Get started → Sign-in method: enable **Email/Password** (only the first switch, not "Email link"). Save.
4. Authentication → Settings → **Authorized domains**: add your Netlify address (for example `yoursite.netlify.app`) and any custom domain.
5. Optional: Authentication → Templates → "Email address verification" to change the sender name, subject and wording. The email comes from a Firebase address by default and can land in spam, so tell users to check there.
6. Push to GitHub. Netlify redeploys and it works.

**Good to know**
- Email sign-ups create a Firebase user with the password the person chose (Firebase stores it hashed). The page still uses its own login for now.
- Each new account saves a `firebaseUid` linking it to its Firebase user.
- Firebase proves the email belongs to the person at sign-up. Accounts still live in each visitor's browser, so someone editing their own browser could skip the step. To enforce it, move login and accounts to Firebase Authentication plus a database.

## Option: your own codes on Netlify (`VERIFY_METHOD = 'server'`)

Skip this whole part if you use Firebase.


1. **Put these files in your GitHub repository** so that `netlify.toml`, `package.json`, `otp.js`, `senders.js`, the `netlify` folder and the `public` folder are at the top level of the repo. The old root `index.html` is no longer used; delete it. **Never upload `.env`** (the included `.gitignore` skips it). If real keys ever reached GitHub, delete them in your provider's dashboard and create new ones.
2. **Add your settings in Netlify:** Site configuration → Environment variables (menu names may differ slightly). Add:
   - `OTP_SECRET`: a long random value. Make one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `NODE_ENV` = `production`
   - Email: `RESEND_API_KEY` and `EMAIL_FROM`
3. **Deploy again.** Pushing to GitHub does this. After adding or changing variables, also use Deploys → Trigger deploy.
4. **Check it:** open `https://YOURSITE.netlify.app/api/health`. You want `otpSecretSet: true`, `storage: "ok"`, and `provider` next to the channel you set up.
5. **Try a sign-up** on your site.

**Testing before you have an email key:** set `NODE_ENV` to `development` in Netlify. Codes are then written to the function log (Netlify → Logs → Functions), not sent and not shown on the website. Switch back to `production` afterwards.

How it fits Netlify: the codes are kept in Netlify Blobs (built in, no extra account), and Netlify itself limits how often one IP can call the endpoints (5 sends per 3 minutes, 20 checks per minute).

## Run on your computer

1. Install Node.js 20.12 or newer. In this folder run `npm install`.
2. Optional: copy `.env.example` to `.env` and set `OTP_SECRET`.
3. `npm start`, then open http://localhost:3000 (not the `index.html` file).
4. With no email key the code is printed in the terminal. `npm test` runs the automated tests.

`VERIFY_METHOD = 'demo'` in `public/index.html` previews the screens with no server at all (the code is shown on screen: not secure, previews only).

## Sending real codes

- **Email:** Resend. `EMAIL_FROM` must use a domain you've verified in Resend (Resend's shared test sender only emails your own account address).
- **Another email provider:** add one function in `senders.js`.

## "We couldn't send your code"

The visitor only sees that generic message. The real reason is in the logs: the terminal running `npm start`, or on Netlify, Logs → Functions (look for `[otp] sending failed:`). Also check `/api/health`. Common causes: `NODE_ENV=production` with no provider keys; placeholder keys left in; Resend domain not verified; variables changed but not redeployed.

If the page says the service "wasn't found", the `netlify` folder or `netlify.toml` isn't in the repo yet, or the site hasn't been redeployed.

## How the codes work

- 6 digits, valid for 10 minutes, usable once. 5 wrong guesses destroy the code. One new code per minute and 5 per hour for each address/number.
- Parallel requests can't get free guesses or trigger extra messages: every change is a compare-and-set write, and the visitor is only told "right" or "wrong" after their attempt was counted.
- Codes and addresses are stored only as keyed hashes. Codes are never written to logs in production.
- After a correct code the server returns a signed token. `checkToken()` in `otp.js` lets a future server-side sign-up confirm an email/number really was verified.

## Before going live

- **Accounts must move to a server database.** Today accounts, passwords and the "confirmed" flag live in each visitor's own browser, so the code check only stops honest users (someone editing their own browser could skip it), passwords are stored in plain text there, and an employer on one device can't see applications made on another. Production needs server-side accounts with hashed passwords (argon2 or bcrypt).
- Small leftover records (one per address/number, no codes inside) stay in Blobs; they can be cleared from the Netlify Blobs page.
- Consider a CAPTCHA on sign-up to limit abuse, and add a privacy notice covering phone numbers (POPIA).
