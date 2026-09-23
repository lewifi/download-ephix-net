# Architecture

Why this is shaped the way it is. For reading before changing `src/index.js`.
For building your own copy, see [INSTRUCTIONS.md](INSTRUCTIONS.md).

## Shape

One Worker, one file, about a thousand lines, no build step and no dependencies. Both
HTML pages are template literals in the same file as the API that feeds them.

That is a deliberate ceiling rather than laziness. The whole thing is a thin authenticated
proxy in front of four applications that already hold all the state. There is no data model
to speak of, so there is nothing for a framework to organise. A build step would add a
failure mode between "it works locally" and "it works deployed", and this is a service you
edit at odd hours and deploy from a phone.

If it grows past roughly two thousand lines, or a third page, split the pages out first and
keep the API in one piece.

## Request lifecycle

```
browser
  -> Cloudflare Access          visitor logs in, gets a session cookie
  -> Worker                     verifies the JWT itself, then checks the email
  -> Access again               Worker presents a service token, not the visitor
  -> *-api.ephix.net            Cloudflare Tunnel
  -> cloudflared at home
  -> Sonarr / Radarr / Prowlarr / qBittorrent on localhost
```

Every route goes through the same gate at the top of `fetch`, before routing. Adding a
route cannot accidentally create an unauthenticated one.

## Two gates, on purpose

`verifyAccessJwt` validates the Access JWT against the team's public keys: audience,
issuer, expiry, signature. Access has already done this before the request arrives, so it
looks redundant.

It isn't. If the Access application is ever deleted, reconfigured or bypassed, a Worker
that merely assumed a proxy was in front of it would become an open door to the whole
media stack. Verifying locally means the Worker fails closed on its own. It also refuses
every request when `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` are unset, so a half-configured
deploy is inert rather than open.

`allowedEmails` is the second gate and answers a different question. Passing Access proves
you are in the Zero Trust organisation. It does not prove you are the right person, and the
Access policy might be widened later by someone who forgets this Worker exists. The email
check is a handful of lines and costs nothing per request.

## The credentials are asymmetric

Inbound and outbound authentication are unrelated, and conflating them is the single
biggest trap in this design.

- **Inbound:** the visitor's Access JWT, in `Cf-Access-Jwt-Assertion`. Access sets it.
- **Outbound:** a service token, in `CF-Access-Client-Id` and `CF-Access-Client-Secret`.

`Cf-Access-Jwt-Assertion` is a header Access *emits* towards an origin once it has already
authenticated somebody. Sending it inbound authenticates nothing. Access accepts exactly
two things: a browser session, or a service token. The Worker is neither until it is given
one.

`originHeaders` prefers the service token and falls back to forwarding the visitor's JWT.
That fallback exists only so a half-configured deploy fails visibly rather than silently,
and it never succeeds. Treat the service token as required.

## Failure is classified structurally, never by text

`arr()` turns transport failures into `OfflineError`:

| What happened | Meaning |
|---|---|
| `fetch` throws | no route to home |
| 5xx | Cloudflare 52x, or the app is down |
| 3xx | Access redirected us to a login page |
| other non-2xx | a real API error, thrown as a plain `Error` |

`isOffline` then checks a flag on the error object, not a substring of its message.

This matters more than it looks. Error text changes between versions and providers, and
string matching on it produces a system that works until someone else's release notes say
otherwise. Classifying on the response's shape means "home is unreachable" stays correct
whether the cause is a dead laptop, a dropped tunnel or a misconfigured Access policy.

A 3xx counting as offline is the non-obvious one. Access answering with a redirect to its
own login page is indistinguishable, from the Worker's side, from the service being down,
and the user-facing consequence is identical.

## Writes that fail are queued, not lost

An add that fails because home is offline goes into KV with a seven day TTL, and a cron
drains it every five minutes until Sonarr or Radarr accept it.

The alternative, retrying inside the request, is worse in every way. The visitor waits, the
Worker burns CPU time, and it still fails if the laptop is off for an hour. Queueing makes
"add this while I think of it" work from a train with the laptop shut, which is most of the
point of the thing existing.

Retries reuse the JWT captured at request time, valid around 24 hours. With a service token
configured the retry path does not depend on it at all, so longer outages still drain.

Only writes are queued. Reads degrade instead, see below.

## Nothing from the client is trusted

Three places where the obvious implementation would trust the browser, and doesn't:

**Grabs re-verify.** `/api/grab` receives a guid and an indexer id, but does not hand them
straight to Prowlarr. It re-runs the search server-side, finds that guid among the results,
and applies `grabbable` to **the indexer's own title**, not the one the page sent. Without
this the executable-name filter would be decoration: it would decide what was displayed
while a hand-written POST fetched anything at all. The search term travels with the pick so
this is possible, falling back to the release title for older cached pages.

**Deletion is impossible from the page.** `subAction` pins `deleteFiles=false`. It is not a
parameter, so no request from anywhere can make the Remove button delete a file. The worst
the page can do is make Sonarr or Radarr stop tracking something, which is a click to undo.

**Paths are constructed, never accepted.** `ROOT_TV` and `ROOT_MOVIES` are module
constants. The folder name comes from the title the indexer returned, through `safeFolder`,
which strips characters Windows forbids, control characters and trailing dots, rejects
reserved device names, and refuses to return an empty string. An empty result would hand
Sonarr the library root as a series path.

## Reads degrade, writes queue

When home is unreachable, search falls back to TMDB through a public proxy on `ephix.net`
that needs no key. You can still search, still see posters, still pick seasons. The add is
queued and applied later.

So the site is useful in three states rather than two: everything up, home down but
Cloudflare up, and nothing up. The middle state is the common one, because the laptop
sleeps and Cloudflare does not.

`queue()` reads qBittorrent directly for progress, because it knows about everything
including raw grabs, and consults Sonarr and Radarr only to put friendly names on the
torrents. If the qBittorrent route is unavailable it falls back to the two arr queues,
which are less complete but always there.

## Where state lives

Nowhere in this Worker, except the offline queue.

| State | Owner |
|---|---|
| What is in the library | Sonarr, Radarr |
| What is downloading | qBittorrent |
| Indexers and grabs | Prowlarr |
| Who you are | Cloudflare Access |
| Failed adds awaiting retry | KV, 7 day TTL |

No database, no sessions, no user table, no cache of the library. Every page load asks the
source of truth. That costs a few hundred milliseconds and removes every cache invalidation
bug that would otherwise exist. For one user on a home connection it is the right trade.

## Observability

Every request path requires a signed-in visitor, which makes "is home reachable" impossible
to answer without someone loading the page. That is a poor position to debug from, and it
cost an entire evening once.

`probeOrigin` runs on the cron, which executes outside Access, and logs which credential the
Worker chose and exactly what came back. `wrangler tail` then answers the question with
nobody present.

Health checks that need a human are not health checks.

## The pages

Server-rendered template literals, no client framework, no bundler. `STYLES` is shared by
both pages so `/shows` cannot drift away from `/` visually.

HTML is served `no-store`, because the JavaScript is inline in it. A cached page means a
browser running an old client against a new API, which is a failure mode worth paying a
round trip to avoid.

Both pages use progressive disclosure over state: the queue polls, the subscriptions list
reloads after an action, and errors render in place on the card that caused them rather
than in a global banner.

## Calling it from another site

The ⬇ buttons on `ephix.net` work because Access sets its session cookie on the
**registrable domain**. A browser signed in at `download.ephix.net` sends that cookie to
`ephix.net` too, so `/api/me` answering is a reliable "this is the owner" test with no
second login and no token in the page.

This only works within one registrable domain, and there is no way around that. Access
preflight handling has to be enabled on the application, otherwise Access answers the
`OPTIONS` with a redirect and the preflight fails before the Worker runs.

## Deliberately absent

- **No user management.** Access owns identity. Adding accounts here would mean owning
  passwords, which is a category of problem worth never having.
- **No database.** See above.
- **No library browser.** Plex does that better and already exists.
- **No content filtering on raw search.** The filter screens executables and tiny files,
  which are fakes, not subject matter.
- **No delete.** Removing something from Sonarr or Radarr is reversible. Deleting a file is
  not, and a phone screen is the wrong place for an irreversible action.
- **No auto-upgrade to 4K.** Adds are pinned to one quality profile. Preferring 4K needs a
  profile that allows 1080p as a fallback, or the first film without a 4K release silently
  downloads nothing.
