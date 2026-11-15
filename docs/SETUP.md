# Setup guide

1. [Register the app in Microsoft Entra ID](#1-microsoft-entra-id-app-registration)
2. [Connect the support mailbox](#2-support-mailbox)
3. [Deploy the server](#3-deploy)
4. [First sign-in and configuration](#4-first-sign-in)
5. [Roll out the Chrome extension to Google Workspace](#5-chrome-extension-for-google-workspace)

---

## 1. Microsoft Entra ID app registration

One app registration covers web sign-in and the extension's API access. Email runs through Google Workspace (step 2), so the app needs no mail permissions in Microsoft.

In the [Entra admin center](https://entra.microsoft.com) go to **Identity → Applications → App registrations → New registration**:

- **Name:** `Help Desk`
- **Supported account types:** *Accounts in this organizational directory only*
- **Redirect URI:** platform **Web**, `https://helpdesk.example.com/auth/callback`

Then:

1. **Overview:** copy the *Application (client) ID* into `ENTRA_CLIENT_ID` and the *Directory (tenant) ID* into `ENTRA_TENANT_ID`.
2. **Certificates & secrets → New client secret:** copy the value into `ENTRA_CLIENT_SECRET`. Note when it expires.
3. **Expose an API:**
   - Set the *Application ID URI* to the default `api://<client-id>`.
   - **Add a scope** named `access_as_user`. Who can consent: *Admins and users*. Display name: "Access the help desk as the signed-in user".
4. **Manifest:** set `"requestedAccessTokenVersion": 2` (labelled `accessTokenAcceptedVersion` in the older manifest editor) and save. The server only accepts v2 tokens.
5. **App roles → Create app role** (twice), both with allowed member types *Users/Groups*:
   - Display name `Help Desk Admin`, value **`Helpdesk.Admin`**
   - Display name `Help Desk Agent`, value **`Helpdesk.Agent`**
6. **Token configuration → Add optional claim → ID** and **Access**: add `email` and `preferred_username`.
7. **API permissions:**
   - Delegated: `openid`, `profile`, `email`, `offline_access`. These are usually present already.
   - Click **Grant admin consent**.
8. **Authentication → Add a platform → Single-page application:** add the extension's redirect URI, `https://<extension-id>.chromiumapp.org/`. You get the extension ID in step 5. The SPA platform lets the extension sign in with PKCE and no secret.

### Assign roles

Go to **Enterprise applications → Help Desk → Users and groups → Add user/group**:

- Add your IT staff (ideally a security group) with role **Help Desk Agent**, and help desk managers with **Help Desk Admin**.
- Everyone else signs in as a *requester* automatically, with no assignment needed.
  - To *restrict* who can sign in at all, set **Properties → Assignment required = Yes** and assign a group such as "All employees" with the default access role.

With `ENTRA_ROLES_AUTHORITATIVE=true` (the default), each user's role is re-read from Entra at every sign-in, so Entra stays the single source of truth. For the very first admin, `BOOTSTRAP_ADMIN_EMAILS` always grants admin.

---

## 2. Support mailbox

Every email to the support address becomes a ticket, and replies thread into the existing ticket. The help desk reads and sends mail as a Gmail mailbox through the **Gmail API**.

### 2.1 Create the help desk mailbox

In the Google Admin console, create a **dedicated user**, e.g. `helpdesk@example.com`.

- It needs a Workspace license, because the Gmail API only works on real mailboxes, not on Google Groups.
- Already have `support@` or `it@` as a **Google Group**? Make it deliver to the mailbox: add `helpdesk@example.com` as a member of the group. Or remove the group and add the address as an **alias** of the helpdesk user. Then set `MAIL_ADDRESS` to the address people actually write to.
  - If replies should come *from* the alias, add it under the mailbox's Gmail **Settings → Accounts → Send mail as**.
- Turn on 2-Step Verification for this account and give it a strong password. Nobody needs to log in to it day to day.

### 2.2 Give the help desk access: pick one method

**Method A — service account with domain-wide delegation (simplest, recommended)**

1. In the [Google Cloud console](https://console.cloud.google.com), create a project, e.g. `helpdesk`.
2. Go to **APIs & Services → Library** and enable the **Gmail API**.
3. Go to **IAM & Admin → Service accounts → Create service account** (name it `helpdesk-mail`). It needs no roles.
4. Open the service account:
   - Under **Keys → Add key → Create new key → JSON**, download the key.
   - Save it on the server as `secrets/google-sa.json`. docker-compose mounts it read-only.
   - If key creation is blocked, your org policy `iam.disableServiceAccountKeyCreation` is enforced. Make an exception for this project, or use Method B.
   - From the service account's details, copy its **Unique ID** (a long number).
5. In the [Google Admin console](https://admin.google.com), go to **Security → Access and data control → API controls → Manage Domain Wide Delegation → Add new**:
   - **Client ID:** the service account's Unique ID
   - **OAuth scopes:** `https://www.googleapis.com/auth/gmail.modify`
6. Set the following in `.env`:

   ```
   MAIL_ADDRESS=helpdesk@example.com
   MAIL_INBOUND=gmail
   MAIL_OUTBOUND=gmail
   GMAIL_AUTH=service_account
   GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/run/secrets/google-sa.json
   ```

> **Security note:** domain-wide delegation lets whoever holds the key act on the Gmail of *any* user in your domain, within that one scope. The help desk only ever impersonates `MAIL_ADDRESS`, but you still need to treat the key as highly sensitive: keep it out of git, restrict access to the server, and rotate it periodically. If that is not acceptable, use Method B.

**Method B — OAuth token for the help desk mailbox only (narrowest access)**

1. In the Google Cloud project, enable the **Gmail API**.
2. Configure **APIs & Services → OAuth consent screen**: type **Internal**, and add the scope `.../auth/gmail.modify`.
3. Go to **Credentials → Create credentials → OAuth client ID** and choose type **Desktop app**. Note the client ID and secret.
4. On your own computer, in a checkout of this repo, run:

   ```bash
   npm install
   GMAIL_OAUTH_CLIENT_ID=… GMAIL_OAUTH_CLIENT_SECRET=… MAIL_ADDRESS=helpdesk@example.com npm run gmail:authorize -w server
   ```

   Open the printed link, sign in **as helpdesk@example.com**, and approve. The script prints a refresh token.
5. Set the following in `.env`:

   ```
   MAIL_INBOUND=gmail
   MAIL_OUTBOUND=gmail
   GMAIL_AUTH=oauth
   GMAIL_OAUTH_CLIENT_ID=…
   GMAIL_OAUTH_CLIENT_SECRET=…
   GMAIL_OAUTH_REFRESH_TOKEN=…
   ```

The token only grants access to that one mailbox. It stops working if the mailbox password changes or the grant is revoked; if that happens, re-run the script.

### 2.3 How the server uses the mailbox

- Every `MAIL_POLL_SECONDS`, it imports Inbox messages that don't yet have the **`Helpdesk/Processed`** label (`GMAIL_PROCESSED_LABEL`).
- After a message is imported, it gets that label, is marked read, and is archived out of the Inbox if `GMAIL_ARCHIVE=true`.
  - The Inbox therefore only ever shows mail that hasn't been processed yet.
- A message that fails to import is left alone and retried on the next poll.
- To keep newsletters or other bulk mail out, use `GMAIL_QUERY`, e.g. `GMAIL_QUERY=-category:promotions -category:social`. Gmail filters on the mailbox also work.
- Outgoing replies are sent from the mailbox through the Gmail API and appear in its **Sent** folder. The server stores the Message-ID Gmail assigns, so requesters' replies thread back to the right ticket.

### Other mail systems

The server also supports Microsoft 365 (`MAIL_INBOUND=graph`, with the Graph `Mail.ReadWrite`/`Mail.Send` application permissions) and generic IMAP/SMTP (`MAIL_INBOUND=imap`, `MAIL_OUTBOUND=smtp`). With Gmail over IMAP you would need an app password, which many Workspace admins disable, so the Gmail API connector above is preferred.

### How email is handled

- **New email:** a new ticket. The sender is the requester, and any To/CC recipients other than the help desk are added as watchers.
- **Reply:** matched to its ticket by the `In-Reply-To`/`References` headers, or by the `[#123]` tag in the subject. Quoted history is stripped.
- **Reply to a closed ticket:** a new *follow-up* ticket linked to the old one.
- **Ignored:** auto-replies, out-of-office messages, bounces, `noreply@` senders, and the help desk's own mail. This prevents mail loops.
- **Domain filter:** set `MAIL_ALLOWED_DOMAINS=example.com` to accept new tickets only from your own domain(s).
- **Mail log:** admins can see every processed message under **Admin → Inbound mail log**, and can trigger an immediate check from there.

---

## 3. Deploy

```bash
git clone … && cd BTC.helpdesk
cp .env.example .env    # fill in all values; generate SESSION_SECRET with: openssl rand -base64 48
docker compose up -d --build
```

Serve it over HTTPS at `APP_URL` through a reverse proxy (Caddy, nginx, Azure Front Door, …) that forwards to port 4000. Back up the `pgdata` and `uploads` volumes.

Health check: `GET /healthz`.

You can also run it without Docker: `npm ci && npm run build`, then from `server/` run `npx prisma migrate deploy && node dist/seed.js && node dist/index.js`.

---

## 4. First sign-in

1. Browse to `APP_URL` and click **Sign in with Microsoft**. Make sure your email is in `BOOTSTRAP_ADMIN_EMAILS`, or that you hold the `Helpdesk.Admin` role.
2. Agents appear under **Admin → Users** after their first sign-in. Ask them to sign in once.
3. **Admin → Teams:**
   - The first start creates *Service Desk*, *Network*, *Identity & Access* and *Hardware*. Rename, delete or add teams to match your organization.
   - Add agents to each team.
   - Choose each team's strategy: round robin or least loaded.
4. **Admin → Auto-assign rules:**
   - Example rules are included. Edit the keywords and use **Test your rules** to check them against real subjects.
   - Rules are evaluated top to bottom. Use ↑/↓ to reorder them.
5. **Admin → Settings & SLA:** set the default team for tickets that match no rule, the SLA hours, and auto-close.
6. Agents can untick **Available for assignment** (bottom left) when they are away, so auto-assignment skips them.

---

## 5. Chrome extension for Google Workspace

The extension is in `extension/`. It needs no build step.

### 5.1 Publish it privately to your domain

1. Package it: `npm run package:extension`. This creates `extension/dist/helpdesk-extension-<version>.zip`.
2. Sign in to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) **with your Google Workspace account**. There is a one-time US$5 developer registration.
3. **New item:** upload the zip and fill in the listing (name, description, icons, one screenshot).
4. Under **Distribution → Visibility**, choose **Private** and *"Everyone at <your domain>"*.
   - Private items are not public and are typically approved quickly.
5. Submit for review. Once published, copy the **extension ID** (32 letters) from the dashboard.

> Prefer not to use the Web Store? You can self-host a `.crx` and `update.xml` and force-install it from that URL. Pack it with **chrome://extensions → Pack extension**, keep the `.pem` safe, and see [Google's guide](https://support.google.com/chrome/a/answer/2714278). The Web Store private listing is much easier to maintain.

### 5.2 Register the extension with Entra and the server

- In the app registration, go to **Authentication → Single-page application** and add `https://<extension-id>.chromiumapp.org/`. The trailing slash matters.
- In `.env`, set `EXTENSION_ORIGINS=chrome-extension://<extension-id>`, then restart.

### 5.3 Force-install and configure it for all users

In the [Google Admin console](https://admin.google.com), go to **Devices → Chrome → Apps & extensions → Users & browsers**.

1. Select the top-level organizational unit, or the OUs that should get the extension.
2. Click **+ → Add Chrome app or extension by ID**. Enter the extension ID and choose *From the Chrome Web Store*.
3. Set **Installation policy** to **Force install** (optionally *Force install + pin to browser toolbar*).
4. Under **Policy for extensions**, paste:

   ```json
   {
     "apiUrl": { "Value": "https://helpdesk.example.com" },
     "tenantId": { "Value": "<ENTRA_TENANT_ID>" },
     "clientId": { "Value": "<ENTRA_CLIENT_ID>" }
   }
   ```

5. Save. Chrome applies the policy within minutes, or immediately at chrome://policy → *Reload policies*.

Users then see the help desk icon in their toolbar. The first time they click **Sign in with Microsoft**, the extension suggests their Google Workspace email as the login hint. It renews tokens silently after that.

> Force-installation through the Admin console only applies when users are signed in to Chrome with their Workspace account (managed profile), or on enrolled ChromeOS / managed browsers. To cover unmanaged Chrome browsers on Windows/Mac, enroll them with **Chrome Enterprise Core** (free), which takes the same policy.

### 5.4 Updating the extension

Bump `version` in `extension/manifest.json`, run `npm run package:extension`, and upload the new zip in the developer dashboard. Chrome updates installed copies automatically.

### Local testing of the extension

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the `extension/` folder.
2. Open the extension's **Options**. Enter the help desk URL, tenant ID and client ID.
3. Add the redirect URI shown on the Options page to the app registration's SPA platform.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `AADSTS50011 redirect URI mismatch` | The redirect URI must match exactly: `<API_URL>/auth/callback` on the **Web** platform; `https://<id>.chromiumapp.org/` on the **SPA** platform. |
| Extension: "Not signed in" right after signing in | Check that `requestedAccessTokenVersion` is `2` and that the `access_as_user` scope exists. |
| Everyone is a requester | Assign the app roles under *Enterprise applications → Users and groups*. Users must sign out and back in. |
| No tickets from email | Check **Admin → Inbound mail log** and the server logs for `[mail]` lines. |
| `unauthorized_client` from Google | The domain-wide delegation entry is missing, has the wrong client ID (use the service account's numeric Unique ID), or lacks the `gmail.modify` scope. Changes can take a few minutes to apply. |
| `Precondition check failed` / `failedPrecondition` | `MAIL_ADDRESS` is not a licensed Gmail user (e.g. it's a group or alias). Point it at the real mailbox, or see 2.1. |
| Google OAuth `invalid_grant` | The refresh token was revoked or the password changed. Re-run `npm run gmail:authorize -w server`. |
| Replies create new tickets | Make sure the `[#123]` tag stays in the subject. Some gateways strip `In-Reply-To` headers. |
