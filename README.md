# WebChat AI Backend

A minimal multi-tenant backend that lets you (or your clients) generate
embeddable chat widget snippets — **without ever exposing your Groq API key
or any client's trained knowledge base** in the browser.

This is the missing piece that turns the WebChat AI HTML demo into something
you can actually hand out to other people/clients as a real product.

## Why this exists

The original single-file WebChat AI HTML demo puts your Groq API key directly
into the `<script>` snippet it generates. That's fine on your own site — it's
**not** fine to give to a client, because anyone can view-source their page
and steal your key. This backend fixes that by moving the key, the knowledge
base, and all logic onto a server you control. Client sites only ever talk
to *your* server.

```
Client website  ──POST /api/chat──▶  YOUR server  ──▶  Groq API
  (embed.js,                          (holds the key,
   no secrets)  ◀──── reply ─────      the knowledge base,
                                       rate limits, logging)
```

## Setup

```bash
npm install
```

Edit `.env` and fill in:
- `GROQ_API_KEY` — your real Groq key (get one free at console.groq.com)
- `ADMIN_SECRET` — a long random string, e.g. `openssl rand -hex 32`. This
  protects the admin endpoints that create/edit/delete bots.

Then run:

```bash
npm start          # production
npm run dev        # auto-restarts on file changes
```

Server starts on `http://localhost:3000` (or whatever `PORT` you set).

> **Database note:** This uses Postgres via the `pg` package — set
> `DATABASE_URL` in `.env` to a real Postgres connection string (Render's free
> Postgres works well; see the deployment section below). The schema is
> created automatically on first startup.

## How to create a bot (i.e. "train" a client's site)

You still do the scraping + content-refinement in the browser, the same way
the original WebChat AI HTML does it (fetch the page through a CORS proxy,
extract text, optionally clean it up with an LLM). Once you have that final
knowledge-base text, send it to your server:

```bash
curl -X POST http://localhost:3000/api/admin/bots \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: YOUR_ADMIN_SECRET" \
  -d '{
    "name": "Acme Support Bot",
    "siteUrl": "https://acme.com",
    "siteName": "Acme",
    "colorGrad": "linear-gradient(135deg,#3d45e0,#818af9)",
    "greeting": "Hi! Ask me anything about Acme.",
    "knowledgeBase": "...the scraped + refined site content...",
    "ownerEmail": "client@example.com"
  }'
```

Response:
```json
{ "token": "sp_AbCdEf123456..." }
```

That token is everything the client needs. Give them this one line to paste
before `</body>` on their site:

```html
<script src="https://your-server.com/embed/sp_AbCdEf123456....js"></script>
```

That's the whole "paste this and boom you have a chat assistant" experience
— except now it's safe to hand out, because the snippet only contains a
public token, never your key or their knowledge base in plaintext.

## Updating / retraining a bot

```bash
curl -X PATCH http://localhost:3000/api/admin/bots/sp_AbCdEf123456... \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: YOUR_ADMIN_SECRET" \
  -d '{ "knowledgeBase": "...new refined content...", "greeting": "New greeting!" }'
```

## Viewing analytics for a bot

No admin secret needed here — analytics are scoped to whoever holds that
specific bot's token, so each client (or you) can safely check their own
bot's stats:

```bash
curl http://localhost:3000/api/analytics/sp_AbCdEf123456...
```

Returns total questions, today's count, most-asked questions, hourly
activity, last-7-days breakdown, and a recent question feed — the same data
the Analytics page in the WebChat AI demo showed, but now persisted server-side
and queryable any time instead of living only in browser memory.

## Endpoints reference

### "Talk to a Human" — how it works

Every embedded widget has a "Talk to a Human" option that appears after bot
replies (more prominently when the AI says it doesn't know something). This
is a real, working two-way conversation — not just a logging stub:

- The widget generates a stable random `visitorId` (stored in that visitor's
  browser via `localStorage`), so multiple messages from the same person
  stay grouped into one conversation instead of looking like separate
  unrelated people.
- Messages go to `POST /api/human-message`, stored in the `human_messages`
  table.
- The widget **polls** `GET /api/human-messages/:token/:visitorId` every 4
  seconds while connected, so it picks up whatever an agent replies.
- If the same visitor returns later (same browser, same site), the widget
  checks for existing history on load and reconnects automatically —
  they'll see their old messages and any reply that came in since.

**To see and reply to these**, from the dashboard's Inbox:
- `GET /api/admin/human-conversations/:token` — every visitor who's messaged
  this bot, grouped, most recent first, with an unread count each.
- `GET /api/admin/human-conversations/:token/:visitorId` — the full thread
  with one visitor (also marks their messages as read).
- `POST /api/admin/human-reply` — send a reply; the visitor's widget picks
  it up on its next poll.

There's no push notification (email/Slack/etc.) when a new message comes in
— you have to check the Inbox. That's a reasonable next addition if this
gets real usage.

| Method | Path                                          | Auth                     | Purpose |
|--------|-----------------------------------------------|--------------------------|---------|
| POST   | `/api/chat`                                   | none (public)            | What every embedded widget calls |
| POST   | `/api/human-message`                          | none (public)            | Visitor sends a message in human mode |
| GET    | `/api/human-messages/:token/:visitorId`       | none (visitorId = access)| Widget polls this for agent replies |
| GET    | `/embed/:token.js`                            | none (public)            | Serves the secret-free embed snippet |
| GET    | `/api/analytics/:token`                       | none (token = access)    | Per-bot analytics |
| GET    | `/api/admin/human-conversations/:token`       | `x-admin-secret` header  | List visitor conversations |
| GET    | `/api/admin/human-conversations/:token/:vId`  | `x-admin-secret` header  | Full thread with one visitor |
| POST   | `/api/admin/human-reply`                      | `x-admin-secret` header  | Agent sends a reply |
| POST   | `/api/admin/bots`                             | `x-admin-secret` header  | Create a new bot, get its token |
| PATCH  | `/api/admin/bots/:token`                      | `x-admin-secret` header  | Update/retrain a bot |
| GET    | `/api/admin/bots`                             | `x-admin-secret` header  | List all bots you've created |
| DELETE | `/api/admin/bots/:token`                      | `x-admin-secret` header  | Delete a bot + its data |
| GET    | `/health`                                     | none                      | Uptime check |

## Deploying to Render (free tier)

This repo includes a `render.yaml` Blueprint that sets up both the web
service and a Postgres database together, and wires them to each other
automatically.

1. **Push this `backend/` folder to its own GitHub repository.**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   # create a new repo on github.com, then:
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```
   Your `.gitignore` already excludes `.env` and `node_modules/` — never commit
   `.env`, it has your real secrets in it.

2. **On Render** (https://dashboard.render.com): **New → Blueprint** → connect
   the GitHub repo you just pushed. Render reads `render.yaml` and shows you
   both resources it's about to create (the web service + the database).

3. **It'll prompt you for the secrets** marked `sync: false` in `render.yaml`:
   `GROQ_API_KEY`, `GEMINI_API_KEY`, `ADMIN_SECRET`. Paste in your real
   values. `DATABASE_URL` is filled in automatically — you don't touch it.

4. Click **Apply**. Render builds and deploys both resources. First deploy
   takes a few minutes.

5. Once live, your backend URL will be something like
   `https://webchat-ai-backend.onrender.com`. Check it:
   ```bash
   curl https://webchat-ai-backend.onrender.com/health
   ```

**Two free-tier things worth knowing:**
- The web service spins down after 15 minutes of no traffic, and takes
  30-60 seconds to wake back up on the next request — the first message to
  an idle bot will feel slow once, then it's normal speed again.
- The free Postgres database is deleted **30 days after creation** (with a
  14-day grace period to upgrade before that happens). For a real production
  bot, budget for Render's ~$6/mo starter Postgres before that deadline, or
  migrate to a provider with a permanent free tier (e.g. Neon).

## Staying awake + surviving the 30-day database expiry

Two automations are included, both as GitHub Actions workflows in
`.github/workflows/`:

### Keep-alive (`keepalive.yml`)
Pings `/health` every 10 minutes so Render's free tier never spins your
service down from inactivity. **Setup:** in your GitHub repo → Settings →
Secrets and variables → Actions → add a secret named `BACKEND_URL` with your
real Render URL (e.g. `https://webchat-ai-backend.onrender.com`).

Honest limitation: GitHub disables scheduled workflows after 60 days with no
commits to the repo, and cron timing isn't guaranteed to the minute. For a
more reliable version of the same thing, a free https://uptimerobot.com
account pinging the same `/health` URL every 5 minutes works well alongside
this (or instead of it) and doesn't depend on repo activity.

### Automatic daily backups (`backup.yml`)
Every day at 03:00 UTC, dumps every bot/question/usage row into
`backups/latest.json` and commits it to the repo. **Setup:** add a secret
named `DATABASE_URL` — use the **External Database URL** from Render's
Postgres dashboard (not the internal one; GitHub Actions runs outside
Render's network, so it needs the externally-reachable connection string).

This means you're never more than a day away from a complete, restorable
snapshot — even if you forget about the 30-day deadline entirely.

### When your database is about to expire (~once a month)

I didn't fully automate creating a replacement database and rewiring
everything, on purpose — that involves Render's API deleting/creating real
infrastructure unattended, and I'd rather you run one command at a moment you
control than have that fail silently at 3am. The actual swap is quick:

1. On Render: create a new free Postgres database (or upgrade the existing
   one to a paid plan instead, which needs none of the steps below — this is
   the simpler option if $6/mo works for you).
2. Copy its connection string, then run locally:
   ```bash
   DATABASE_URL="postgresql://...new-db-connection-string..." npm run restore
   ```
   This rebuilds the new database from `backups/latest.json`, with every bot
   keeping its **exact original token** — nobody's embed `<script>` tag
   needs to change.
3. On Render, update your web service's `DATABASE_URL` environment variable
   to point at the new database, and let it redeploy.
4. Delete the old (expiring) database once you've confirmed the new one
   works.

Total hands-on time: a couple of minutes.

## Production checklist before letting real clients use this

This is a solid, working foundation — but a few things are intentionally
left simple so you can extend them as you grow:

- **Admin auth** is a single shared secret right now. Fine for you alone;
  swap for real per-client login (sessions, JWT, or an auth provider) before
  letting clients log in and self-serve their own bot creation.
- **Rate limiting** is in-memory per-process. If you ever run more than one
  server instance behind a load balancer, move the limiter to Redis so all
  instances share the same counters.
- **No usage caps / billing** yet — `usage_daily` table tracks request counts
  per bot per day, so you have the data to build "free tier = 100 msgs/day"
  style limits whenever you want them.
- **HTTPS** — deploy behind a host that gives you TLS for free (Render,
  Railway, Fly.io, a reverse proxy with Let's Encrypt, etc.) before going
  live; browsers will warn on/block mixed content otherwise.
- **CORS on `/api/chat`** is wide open by design — that endpoint must be
  callable from any client domain. Everything else (`/api/admin/*`) is
  protected by the secret header instead of CORS, since CORS only restricts
  browsers, not curl/server-to-server calls.

## File structure

```
webchat-ai-backend/
├── server.js          # entry point, wires up routes + middleware
├── db/
│   └── index.js        # Postgres connection pool + thin query wrapper
├── routes/
│   ├── chat.js          # public POST /api/chat — the core proxy to Groq
│   ├── embed.js          # serves the secret-free widget script
│   ├── analytics.js       # per-token analytics
│   ├── admin.js            # create/update/list/delete bots
│   └── scrape.js            # server-side page fetcher for the Train AI tab
├── scripts/
│   ├── backup.js         # dump all bot/question data to backups/latest.json
│   └── restore.js         # rebuild a fresh database from that backup, same tokens
├── .github/workflows/
│   ├── keepalive.yml    # pings /health every 10 min so Render doesn't sleep it
│   └── backup.yml        # runs backup.js daily, commits the result
├── render.yaml         # Render Blueprint (web service + Postgres, together)
├── .env
└── package.json
```
