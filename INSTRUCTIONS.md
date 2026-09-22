# Build this yourself

How to put a Cloudflare Worker, gated by Cloudflare Access, in front of a service running
on a machine at home. No open ports, no port forwarding, no VPN, no dynamic DNS.

This repo uses Sonarr and Radarr as the worked example, but the pattern is the point and
nothing in Parts 2 to 5 cares what is behind it. Swap in Home Assistant, a NAS, Grafana,
a Raspberry Pi, anything that speaks HTTP on localhost.

```
phone or browser
  -> Cloudflare Access          login, one-time PIN to your email
  -> Worker   app.example.com   your code, this repo
  -> Access again               service token, not your login
  -> api.example.com            Cloudflare Tunnel
  -> cloudflared at home
  -> the service on localhost
```

Two independent gates. A visitor has to pass Access to reach the Worker at all, and the
Worker verifies the Access JWT itself rather than trusting that Access is in front of it.
If someone ever removes the Access application, the Worker still refuses everything.

## Before you start

- A domain on Cloudflare, on any plan including the free one
- Cloudflare Zero Trust, free for up to 50 users, no card needed
- Node and `wrangler` (`npm install -g wrangler`, then `wrangler login`)
- The service you want to expose, already running and reachable on `localhost` at home

Read the whole of Part 4 before you start Part 4. It contains three mistakes that all
produce an identical, unhelpful symptom.

## Part 1: the service at home

Whatever it is, get it working on localhost first and note the port. For the Sonarr and
Radarr example, the [Servarr wiki](https://wiki.servarr.com/) covers installation properly
and there is no point repeating it here. You want them running and reachable at
`http://localhost:8989` and `http://localhost:7878`, and you want each app's API key, found
under Settings, General, or in `config.xml` in its data directory.

## Part 2: Cloudflare Tunnel

The tunnel is an outbound-only connection from your machine to Cloudflare. That is what
removes the need for an open port.

1. Zero Trust dashboard, Networks, Tunnels, **Create a tunnel**, type Cloudflared, give it
   a name.
2. On the install step, pick your platform and copy the install command it gives you. On
   Windows run it in PowerShell **as Administrator**. It registers a service that starts
   with the machine.
3. On the **Public Hostname** tab, add one entry per service:
   - `api` . `example.com` -> Service `HTTP` -> `localhost:8989`

   Add a second hostname for each additional service. They can all live on one tunnel.

Check the tunnel says **Healthy** before moving on. The connector also exposes a local
metrics endpoint, usually `http://127.0.0.1:20241/metrics`, which becomes useful later.

At this point your service is on the public internet with no authentication at all. Do
Part 3 now, not tomorrow.

## Part 3: the Access application

1. Zero Trust, Access, Applications, **Add an application**, Self-hosted.
2. Name it, then add **every** hostname it should cover: your Worker's hostname
   (`app.example.com`) and each tunnel hostname (`api.example.com`). One application
   covering all of them keeps the audience tag consistent, which matters in Part 4.
3. Identity: **One-time PIN** is enough and needs no identity provider. Enable it under
   Settings, Authentication if it is not already on.
4. Add a policy: action **Allow**, include **Emails**, your address. This is the policy
   that lets *you* in through a browser.
5. Save, reopen the application, and copy two values:
   - **Application Audience (AUD) Tag**, a long hex string, under Overview
   - your **team domain**, `<team>.cloudflareaccess.com`, under Settings, Custom Pages

Visiting `api.example.com` in a private window should now show a Cloudflare login page and
never the service itself. Confirm that before continuing.

## Part 4: the service token

**This is the part everyone gets wrong, including me, three different ways in one evening.**

Your Worker is not a browser. It has no Access session cookie. Access accepts exactly two
things: a browser session, or a service token. It does **not** accept a forwarded
`Cf-Access-Jwt-Assertion` header, which is something Access *emits* towards your origin
after it has already authenticated somebody. Sending it inbound authenticates nothing.

Without a service token, every call your Worker makes to `api.example.com` gets a 302 to
the login page, and your code will most likely interpret that as "the service is down".

### 4a. Create the token

Zero Trust, Access controls, Service credentials, Service Tokens, **Create Service Token**.

- Copy the **Client Secret** immediately. It is displayed exactly once and cannot be
  recovered. If you lose it, the three dots menu has **Rotate secret**, which issues a new
  secret and keeps the same Client ID, so any policy referencing the token stays valid.
- The **Client ID ends in `.access`**, as in `a1b2c3...f9.access`. Use the dashboard's copy
  button. Selecting it by hand drops the suffix, and a truncated Client ID fails in exactly
  the same way as a wrong secret, with no distinguishing error.

### 4b. Create the policy, with the right action

Add a policy with action **Service Auth**, including **Service Token**, your token, and
nothing else.

It must be Service Auth. If you use **Allow**, Access still wants an identity provider
login and bounces your Worker to the login page. Cloudflare's own dashboard warns about
this inline: "For service tokens, use the Service Auth action, not Allow."

Do not add an email rule to this policy. Your browser login is handled by the separate
Allow policy from Part 3, which stays exactly as it is.

### 4c. Attach the policy to the application

A policy created from the **Policies** page is a *reusable* policy, and it starts attached
to nothing. On its own it does precisely nothing, while looking entirely correct.

Go to Access controls, Applications, your application, the **Policies** tab, **Add existing
policy**, pick it, **Save**.

Then go back to the Policies list and confirm the row reads **Used by applications: 1**. If
it says 0, it is not attached and nothing you do elsewhere will help.

## Part 5: the Worker

Set the two public values in `wrangler.jsonc` under `vars`:

```jsonc
"vars": {
  "ACCESS_TEAM_DOMAIN": "yourteam.cloudflareaccess.com",
  "ACCESS_AUD": "the long hex audience tag",
  "ALLOWED_EMAILS": "you@example.com",
  "SERVICE_URL": "https://api.example.com"
}
```

`ALLOWED_EMAILS` is a second gate inside the Worker. Passing Access proves you are in the
Zero Trust organisation, not that you are the right person, and the Access policy might be
widened later. It costs nothing to check.

Then the secrets, which never go in a file:

```powershell
wrangler secret put ACCESS_CLIENT_ID
wrangler secret put ACCESS_CLIENT_SECRET
wrangler secret put SERVICE_API_KEY
wrangler deploy
```

The Worker sends the token on every origin call:

```js
headers: {
  'CF-Access-Client-Id': env.ACCESS_CLIENT_ID,
  'CF-Access-Client-Secret': env.ACCESS_CLIENT_SECRET,
  'X-Api-Key': env.SERVICE_API_KEY,
}
```

and verifies the incoming visitor JWT itself against your team's public keys, checking
audience, issuer and expiry, before doing anything. See `src/index.js`, `verifyAccessJwt`.

Secrets take effect on the next request. No redeploy needed.

## Part 6: verify, properly

Configured correctly and verified are different things, and the gap between them is where
whole evenings go.

1. `app.example.com` in a private window shows the Access login, not your app.
2. `api.example.com` in a private window shows the Access login, never the service.
3. Sign in and use the app for real, exercising a path that actually calls the origin.
4. Zero Trust, Service credentials, your token: **Last Seen** should show a time, not
   `Not Seen Yet`, and **Usage** should name your application.

Point 4 is the one that matters. It is the difference between believing it works and
knowing it does.

## When it does not work

All three Part 4 mistakes produce an identical 302 to the login page. Check in this order,
most conclusive first.

| Check | Where | Meaning |
|---|---|---|
| **Last Seen** | Service Tokens, your token | `Not Seen Yet` means Access has never validated it. Nothing downstream matters. Your Client ID or secret is wrong. |
| **Used by applications** | Policies list | `0` means the policy is orphaned. Attach it. |
| **Policy action** | The policy itself | `Allow` instead of `Service Auth` bounces the Worker to a login page. |
| **Tunnel request counter** | `http://127.0.0.1:20241/metrics` at home, `cloudflared_tunnel_total_requests` | If it does not move when you use the app, nothing is reaching home at all, so the fault is at Access and not in your tunnel ingress rules. |

Add a health check your Worker can run without a human present. A Cron Trigger runs outside
Access, so it is the one place the Worker can report on its own credentials with nobody
signed in:

```js
async scheduled(event, env, ctx) {
  ctx.waitUntil(probeOrigin(env));
}
```

Log the status and the redirect target, then `wrangler tail`. "Is the origin reachable" is
otherwise unanswerable without someone loading the page, which is a bad position to debug
from.

## Gotchas in the example stack

Only relevant if you are exposing these particular applications, but each cost real time.

- **Sonarr and Radarr reject unknown Host headers.** `<AllowedHosts>` in `config.xml` must
  contain your tunnel hostname as well as `localhost`, or every request returns
  "Bad Request - Invalid Hostname". Restart the service afterwards. The in-app restart
  button does nothing when it is running as a service.
- **qBittorrent's Web UI "server domains" field is semicolon separated.** Using a comma
  creates one bogus domain and locks out *everything*, including your other applications,
  until you stop qBittorrent and fix the ini by hand.
- **Windows services run as `LOCAL SERVICE`** by default, which cannot read your user
  profile folders. If you point an application at a script under `C:\Users\<you>\...`, it
  reports "File does not exist" even though the file plainly exists. Grant that one folder
  read and execute, or keep the script somewhere the service can already reach.
- **Prowlarr's grab response always says `protocol: unknown`.** It is cosmetic.

## Putting controls on your own site

You can call the Worker from another site you own, so an existing page grows an owner-only
button instead of you visiting the Worker directly. Access does all the work, and the
button appears for you and stays invisible to everybody else, with no second login and no
token in the page.

**The hard constraint: both must share a registrable domain.** The Access session cookie is
set on `example.com`, so a browser signed in at `app.example.com` sends it to
`example.com` and `www.example.com` as well. It will not travel to a different apex domain,
and there is no way around that. If your site is on a separate domain, host the page on a
subdomain of the same one instead.

Given that, four pieces:

1. **Allow the origin in the Worker**, and allow credentials, or the cookie is dropped:

   ```js
   const CORS_ORIGINS = new Set(['https://example.com', 'https://www.example.com']);
   // when the Origin matches:
   'Access-Control-Allow-Origin': origin,       // echo it, never '*' with credentials
   'Access-Control-Allow-Credentials': 'true',
   'Vary': 'Origin',
   ```

2. **Answer the preflight** before the auth gate, since an `OPTIONS` request carries no
   cookie and would otherwise be refused:

   ```js
   if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
   ```

3. **Let preflights reach the Worker.** Access intercepts `OPTIONS` by default and answers
   with a redirect, which fails the preflight before your code runs. The Access application
   has a setting to send CORS preflight requests to the origin instead. Turn it on, along
   with allowing credentials and your origin, under the application's settings.

4. **Call it with `credentials: "include"`** and treat a failure as "not the owner":

   ```js
   let owner = false;
   try {
     const r = await fetch(`${WORKER}/api/me`, { credentials: 'include', cache: 'no-store' });
     owner = r.ok;
   } catch { /* not signed in, leave the UI alone */ }
   ```

That last line is the pattern worth stealing. Rather than a login state you have to manage,
the question "should this person see the controls" becomes one cheap request that Access
has already answered for you. A public visitor gets a redirect or a failure, `owner` stays
false, and the page renders exactly as it always did.

## Using this for something else

Parts 2 to 5 are the reusable core and know nothing about media. To adapt it:

1. Change the tunnel hostname and its `localhost:port` target.
2. Put every hostname in one Access application so they share one audience tag.
3. Point `SERVICE_URL` at your tunnel hostname and swap the API key header for whatever
   your service expects.
4. Replace the page and the API routes in `src/index.js`. The JWT verification, the email
   allow list, the service token headers and the cron probe all stay as they are.

The useful bits to keep, whatever you put in front:

- Verify the Access JWT in the Worker instead of trusting the proxy
- An allow list of identities, so passing Access is not sufficient on its own
- Queue writes that fail because home is offline, and retry them from a cron, rather than
  losing them
- Decide "offline" from *how* a call failed, a network error, any 5xx, or a redirect to a
  login page, and never by matching on error text
