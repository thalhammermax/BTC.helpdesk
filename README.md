# BTC Help Desk

A self-hosted IT help desk with:

- **Email as the primary channel.** Mail to your support mailbox becomes a ticket, and replies thread back into the same ticket.
- **Keyword auto-assignment.** Rules match words in the subject and/or description and route tickets to a team or agent.
- **Microsoft Entra ID single sign-on** for everyone (requesters, agents, admins), with roles from Entra app roles.
- **A Chrome extension** you can force-install for your whole Google Workspace domain.

## Features

| Area | What you get |
|---|---|
| Tickets | Statuses (New, Open, Pending, On hold, Resolved, Closed) · priorities · categories · tags · teams · assignee · CC/watchers · attachments · merge · bulk edit · full history/audit log |
| Conversation | Public replies (emailed to requester and CCs) · **internal notes** (agents only) · canned responses · attachments both ways |
| Email | **Google Workspace / Gmail** mailbox through the Gmail API (also supports Microsoft 365 through Graph, or any IMAP/SMTP mailbox) · threading by `In-Reply-To`/`References` headers and a `[#123]` subject tag · strips quoted history · ignores auto-replies, bounces and loops · CC'd people become watchers · optional sender-domain allow-list · mail log for admins |
| Auto-assign | Ordered rules · match subject, description or both · *any* / *all* keywords · whole-word or substring · `print*` wildcards · phrases · `/regex/` · exclude words · actions: team, agent, priority, category, tags · stop / continue · hit counters · **live rule tester** · team strategies: **round robin** or **least loaded**, skipping agents marked unavailable · default team fallback |
| SLA | First-response and resolution targets per priority · due/overdue indicators · overdue view |
| Portal | Requesters see and reply to their own tickets, can mark them resolved and reopen them |
| Agents | Dashboard (workload, overdue, trends, per-team load) · views: Assigned to me, Unassigned, My teams, Overdue, All · search · filters · sorting |
| Admin | Rules, teams, users, categories, canned responses, SLA and settings, inbound mail log |
| Automation | Acknowledgement email with ticket number · reopen on reply · auto-close resolved tickets after N days |
| Chrome extension | Sign in with Microsoft · create a ticket from any page (page URL and an optional screenshot attached) · right-click a page or selected text to report it · "My tickets" list with unread badge · notifications when a ticket is resolved · agents also get "Assigned to me" · centrally configured by Google Admin policy |

## Architecture

```
server/     Node.js + TypeScript API (Express, Prisma, PostgreSQL)
            ├─ Entra OIDC sign-in (web) + Entra bearer tokens (extension)
            ├─ Mail poller (Gmail API, Graph or IMAP) → ticket engine → rules engine
            └─ Serves the built web app in production
web/        React single-page app (agent console, requester portal, admin)
extension/  Chrome extension (Manifest V3, no build step)
infra/      Azure infrastructure (Bicep) and deploy scripts
docs/       Setup guides
```

## Quick start (local development)

Requirements: Node 20+ and PostgreSQL 14+.

```bash
cp .env.example .env            # set DATABASE_URL, and DEV_LOGIN=true for local testing
npm install
cd server && npx prisma migrate deploy && npm run db:seed && cd ..
npm run dev                     # API on :4000, web on http://localhost:5173
```

With `DEV_LOGIN=true`, the login page shows a development sign-in form so you can try every role without Entra. That form is always disabled when `NODE_ENV=production`. Leave `MAIL_OUTBOUND=log` to print outgoing email to the console.

Tests:

```bash
npm test                                                        # unit tests
TEST_DATABASE_URL=postgresql://…/helpdesk_test npm test -w server  # plus end-to-end tests (wipes that DB)
```

## Production

The recommended deployment is **Azure**: App Service, PostgreSQL Flexible Server, Blob Storage and Key Vault. It is defined in `infra/main.bicep`, deployed with `./infra/deploy.sh`, and updated automatically by GitHub Actions on every push to `main`.

**→ [docs/AZURE.md](docs/AZURE.md)** is the step-by-step runbook for `helpdesk.beth-tikvah.org`.

Any Docker host also works (`docker compose up -d --build`, attachments on a local volume).

**Product setup** (Entra app registration, the Gmail mailbox, rolling out the Chrome extension through Google Workspace) is in **[docs/SETUP.md](docs/SETUP.md)**.
