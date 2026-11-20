# Running the help desk on Azure

Target: **https://helpdesk.beth-tikvah.org**, in **North Central US** (Illinois, close to Chicago), on your Azure sponsorship subscription.

| Piece | Azure service | Approx. monthly cost |
|---|---|---|
| App (web, API, Gmail poller) | App Service for Linux containers, B1, Always On | ~$13 |
| Database | PostgreSQL Flexible Server, Burstable B1ms, 32 GB, 14-day point-in-time backups | ~$17 |
| Attachments | Blob Storage, managed identity only, 14-day soft delete | < $1 |
| Secrets | Key Vault, read by the app through its managed identity | pennies |
| Images | Container Registry, Basic | ~$5 |
| Logs and alerts | Log Analytics, plus email alerts if the site is unhealthy or throwing errors | ~$1–3 |

Total is roughly **$35–40/month**, paid from the sponsorship credits.

> **Region:** set by `location` in `infra/main.parameters.json` (`northcentralus`). Decide **before the first deployment**: moving regions later means redeploying and migrating the database.

Everything is defined in `infra/main.bicep`. **Change settings by editing `infra/main.parameters.json` and re-running `./infra/deploy.sh`**, not in the Azure portal: a redeploy overwrites settings changed in the portal.

---

## Before you start

You need:
- **Owner** on the sponsorship subscription
- Rights to create app registrations in Microsoft Entra
- Google Workspace admin
- Access to the DNS for `beth-tikvah.org`

Check the sponsorship's **remaining credit and end date** at <https://www.microsoftazuresponsorships.com>. Put a reminder in your calendar a month before it ends: the subscription must then be converted to pay-as-you-go, or the resources are disabled.

## Step 1 — Entra app registration

Follow [SETUP.md §1](SETUP.md#1-microsoft-entra-id-app-registration) using:
- Web redirect URI: `https://helpdesk.beth-tikvah.org/auth/callback`

Keep the **client ID** and the **client secret value** for step 4.

## Step 2 — Gmail mailbox and Google key

Follow [SETUP.md §2](SETUP.md#2-support-mailbox): create `helpdesk@beth-tikvah.org` and use **Method A** (service account). Download the JSON key and keep it handy for step 4. Do not commit it.

## Step 3 — Fill in the parameters

Edit `infra/main.parameters.json`:

| Parameter | Value |
|---|---|
| `entraClientId` | client ID from step 1 |
| `bootstrapAdminEmails` | your Entra sign-in email, e.g. `max@beth-tikvah.org` |
| `alertEmail` | where outage alerts go |
| `mailAddress` | the help desk mailbox (default `helpdesk@beth-tikvah.org`) |
| `mailAllowedDomains` | leave empty if congregants email from personal addresses. Set it to `beth-tikvah.org` to accept staff only. |

Commit the change. It contains no secrets.

## Step 4 — Deploy

The easiest place to run the script is **Azure Cloud Shell** (portal → `>_` icon → Bash). Azure CLI, git and openssl are preinstalled there.

```bash
# 1. Get the code. The repo is private, so authenticate first:
gh auth login                       # choose GitHub.com → HTTPS → login with a web browser
gh repo clone thalhammermax/BTC.helpdesk && cd BTC.helpdesk
git checkout main                   # or the branch you want to deploy

# 2. Upload the Google JSON key: Cloud Shell toolbar → Manage files → Upload (it lands in ~)

# 3. Deploy. It prompts once for the Entra client secret.
GOOGLE_SA_KEY=~/google-sa.json ./infra/deploy.sh

# 4. Remove the key from Cloud Shell. It is now in Key Vault.
shred -u ~/google-sa.json
```

What the script does:
1. Validates the template, then creates the resource group `rg-btc-helpdesk` and every resource in it (about 10 minutes the first time).
2. Generates the database password and a session secret, and stores them in Key Vault, together with the Entra client secret and the Google key.
3. Builds the container image inside Azure. Nothing needs to be installed on your computer.
4. Starts the app and waits until it is healthy. The first start creates the database tables and starter data.
5. Prints the DNS records and the GitHub settings for the next steps.

It is safe to re-run whenever you change parameters. Add `SKIP_BUILD=1` to skip rebuilding the image.

> **`LocationIsOfferRestricted` / no capacity in North Central US?** Some sponsorship subscriptions can't create every service in every region.
> - If only PostgreSQL is blocked, add `"postgresLocation": { "value": "centralus" }` (Iowa, still close) to the parameters file and re-run.
> - If App Service is blocked too, change `location` to `centralus` and re-run.

## Step 5 — Custom domain and HTTPS

At your DNS provider for `beth-tikvah.org`, create the two records the script printed:

| Type | Name | Value |
|---|---|---|
| CNAME | `helpdesk` | `btc-helpdesk-<id>.azurewebsites.net` |
| TXT | `asuid.helpdesk` | the verification ID the script printed |

Wait a few minutes for DNS, then run:

```bash
./infra/bind-domain.sh
```

This adds the domain and a **free, auto-renewing TLS certificate**. The site is then live at https://helpdesk.beth-tikvah.org.

> **Cloudflare DNS?** Set the CNAME to **DNS only** (grey cloud) at least until the certificate is issued.

## Step 6 — Automatic deployments from GitHub

1. In GitHub, go to **Settings → Secrets and variables → Actions → Variables** tab. Add the six `AZURE_*` values printed by the script as **repository variables**. They are identifiers, not secrets.
2. Optional: under **Settings → Environments → production**, which appears after the first deploy, add yourself as a required reviewer so each deploy waits for your approval.

From then on, every push to `main`:
1. runs the full test suite against a real PostgreSQL;
2. builds the image and pushes it to the registry;
3. deploys it and waits for the health check.

GitHub logs in to Azure through a federated identity, so **no Azure passwords are stored in GitHub**. That identity can only push images and update this one web app.

You can also deploy manually: **Actions → CI / Deploy → Run workflow**.

## Step 7 — Smoke test

1. Open https://helpdesk.beth-tikvah.org and sign in with Microsoft. You should land on the agent dashboard as an admin.
2. From another account, email `helpdesk@beth-tikvah.org`. Within a minute it shows up under **Admin → Inbound mail log** and as a ticket, and you get the acknowledgement email.
3. Reply to the ticket from the web, then reply to that email. Your reply should thread into the same ticket.
4. Continue with [SETUP.md §4](SETUP.md#4-first-sign-in) (teams, rules, SLA) and [§5](SETUP.md#5-chrome-extension-for-google-workspace) (Chrome extension).
   - After publishing the extension, set `extensionOrigins` to `chrome-extension://<id>` and re-run `SKIP_BUILD=1 ./infra/deploy.sh`.

---

## Day-to-day operations

| Task | How |
|---|---|
| Live logs | `az webapp log tail -g rg-btc-helpdesk -n <web app>`, or portal → App Service → Log stream |
| Search old logs | Portal → Log Analytics workspace → Logs → table `AppServiceConsoleLogs` |
| Change a secret | `az keyvault secret set --vault-name <kv> -n entra-client-secret --value '…'`, then `az webapp restart …` |
| Rotate the Entra client secret | Create a new secret in the app registration **before the old one expires**, store it as above, restart, then delete the old one |
| Restore the database | Portal → PostgreSQL server → **Restore** to any point in the last 14 days (creates a new server, then swap `database-url`) |
| Recover a deleted attachment | Storage account → container `attachments` → show deleted blobs (14 days) |
| More capacity | Set `appServiceSku` to `B2`/`S1`, re-run `deploy.sh` with `SKIP_BUILD=1` |
| Stop paying | Delete the resource group `rg-btc-helpdesk`. Key Vault stays soft-deleted for 30 days; `az keyvault purge -n <kv>` removes it for good |

### Secrets in Key Vault

| Secret | Purpose |
|---|---|
| `database-url`, `postgres-admin-password` | PostgreSQL connection (generated) |
| `session-secret` | Signs sign-in cookies (generated) |
| `entra-client-secret` | Entra app registration secret |
| `google-service-account-json` | Gmail API access (Method A) |
| `gmail-oauth-client-id`, `gmail-oauth-client-secret`, `gmail-oauth-refresh-token` | Gmail API access (Method B, if `gmailAuth` = `oauth`) |

### Security notes

- **Database:** accepts TLS connections only, from Azure services. It is password protected, and the password is generated and kept in Key Vault. For stricter isolation, the database can be moved onto a private virtual network later. App Service B1 supports that.
- **Storage:** Blob Storage disallows account keys entirely. Only the app's managed identity can read or write attachments.
- **The site:** App Service enforces HTTPS and TLS 1.2+, and FTP is disabled.
