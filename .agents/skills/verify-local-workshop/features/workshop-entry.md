# Workshop entry

A local user can open Workshop and reach account sign-in without Cloudflare credentials.

## Sub-features

- `entry-chatgpt` opens Workshop with the local broker enabled.
- `entry-plain` opens Workshop without the broker.
- `entry-signup` exposes the account-creation page without submitting credentials.
- `signup-submit` loads the lazy password-hashing module and reaches Setup with an explicitly authorized synthetic local account.

## How to get to it (user POV)

Open `http://localhost:8787/` after starting either launch mode. Follow **Create one** to `/signup`.

## Driving it with chrome-devtools-axi

Preconditions: this verification run owns port 8787, Doctor passes, and the browser uses an isolated profile.

- Open `chrome-devtools-axi open http://localhost:8787/`. Require **Cloudflare OS**, **Sign in to your account**, the **Username** and **Password** fields, and the disabled **Sign in** button for empty fields.
- Take a fresh `chrome-devtools-axi snapshot`, then `chrome-devtools-axi click @UID` using the **Create one** link's UID. Require the `/signup` page to render. Do not create an account unless the task authorizes a synthetic local account.
- Save screenshots and snapshots for both pages. Run `chrome-devtools-axi console` and report errors rather than hiding them.
- Repeat in plain mode after cleanly stopping ChatGPT mode. A result from one mode does not cover the other.

For an explicitly authorized signup reproduction, use `chrome-devtools-axi run` so a generated test password stays out of shell arguments, snapshots, and stdout:

```sh
chrome-devtools-axi run <<'EOF'
await page.open('http://localhost:8787/signup');
await page.wait('input[autocomplete="new-password"]');
await page.fill('input[autocomplete="username"]', 'verification' + Date.now());
const ids = await page.eval(() => [...document.querySelectorAll('input[type="password"]')].map(el => el.id));
if (ids.length !== 2 || ids.some(id => !id)) throw new Error('Expected two labeled password fields');
const password = await page.eval(() => crypto.randomUUID() + crypto.randomUUID());
for (const id of ids) await page.fill(`input[id=${JSON.stringify(id)}]`, password);
await page.click('button[type="submit"]');
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  ready = await page.eval(() => document.title === 'Setup - Cloudflare OS');
  if (ready) break;
  await page.wait(500);
}
if (!ready) throw new Error('Signup did not reach Setup; inspect the visible error without recording password fields');
console.log('PASS signup loaded the password-hashing module and reached Setup');
EOF
```

Record the post-submit Setup screenshot. Complete onboarding with **Next**, skip adding a model, turn off the three optional built-in tools, then **Next** and **Let's build**. Require the authenticated Home page. Do not connect external services or send a chat. Preserve the synthetic account and its browser profile rather than deleting persistent data without approval.

Run Doctor's asset checks too. Every built JavaScript chunk must return JavaScript, not the SPA's HTML fallback, and match the current build. `index.esm-*.js` contains the dynamically loaded `hash-wasm` password-hashing code, not Firebase. A successful signup is the user-path check that this module can execute.

## Gotchas

- A fresh user is routed through Setup even at `/providers`. Onboarding permits skipping model selection, so a paid API key is not required to reach Providers.
- Use an alphanumeric username starting with a letter. The backend rejects hyphens even though the current signup form accepts them locally.
- Keep the server running during signup. Rebuilds replace hashed asset names, so hard-refresh an old browser tab after a rebuild before retrying a dynamic-import failure. Do not rebuild the frontend while another person is using the local instance.
- The frontend can return HTTP 200 while its backend session is broken. Require the rendered form, not just downloaded HTML.
- Existing browser sessions may open an authenticated page. Do not inspect cookies or local storage to discover credentials.
- A user-created account is persistent local data, not disposable test material.
