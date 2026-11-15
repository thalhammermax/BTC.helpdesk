import 'node:process';

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required environment variable ${name}`);
  return v;
}
const opt = (name: string, fallback = '') => process.env[name] ?? fallback;
const list = (name: string) =>
  opt(name)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export const config = {
  port: Number(opt('PORT', '4000')),
  /** Public URL of the web app / API, e.g. https://helpdesk.example.com */
  appUrl: opt('APP_URL', 'http://localhost:5173').replace(/\/$/, ''),
  apiUrl: opt('API_URL', 'http://localhost:4000').replace(/\/$/, ''),
  sessionSecret: req('SESSION_SECRET', process.env.NODE_ENV === 'production' ? undefined : 'dev-insecure-secret-change-me'),
  uploadDir: opt('UPLOAD_DIR', './uploads'),
  storage: {
    /** local | azure */
    driver: opt('STORAGE_DRIVER', 'local') as 'local' | 'azure',
    account: opt('AZURE_STORAGE_ACCOUNT'),
    connectionString: opt('AZURE_STORAGE_CONNECTION_STRING'),
    container: opt('AZURE_STORAGE_CONTAINER', 'attachments'),
  },
  maxUploadMb: Number(opt('MAX_UPLOAD_MB', '25')),
  /** Origins allowed to call the API with bearer tokens (the Chrome extension). */
  extensionOrigins: list('EXTENSION_ORIGINS').map((o) => o),

  entra: {
    tenantId: opt('ENTRA_TENANT_ID'),
    clientId: opt('ENTRA_CLIENT_ID'),
    clientSecret: opt('ENTRA_CLIENT_SECRET'),
    /** App role values (from the app registration) that map to helpdesk roles */
    adminRole: opt('ENTRA_ADMIN_ROLE', 'Helpdesk.Admin'),
    agentRole: opt('ENTRA_AGENT_ROLE', 'Helpdesk.Agent'),
    /** Emails that are always admins (bootstrap) */
    bootstrapAdmins: list('BOOTSTRAP_ADMIN_EMAILS'),
    /** When true, a user's role is recomputed from Entra app-role claims at every sign-in. */
    rolesAuthoritative: opt('ENTRA_ROLES_AUTHORITATIVE', 'true') === 'true',
  },

  /** Local development only: enables /auth/dev-login so you can run without Entra. */
  devLogin: opt('DEV_LOGIN') === 'true' && process.env.NODE_ENV !== 'production',

  mail: {
    /** gmail | graph | imap | none */
    inbound: opt('MAIL_INBOUND', 'none') as 'gmail' | 'graph' | 'imap' | 'none',
    /** gmail | graph | smtp | log */
    outbound: opt('MAIL_OUTBOUND', 'log') as 'gmail' | 'graph' | 'smtp' | 'log',
    /** The support mailbox address, e.g. helpdesk@example.com */
    address: opt('MAIL_ADDRESS', 'helpdesk@example.com').toLowerCase(),
    fromName: opt('MAIL_FROM_NAME', 'Help Desk'),
    pollSeconds: Number(opt('MAIL_POLL_SECONDS', '60')),
    /** Only accept tickets from these sender domains (empty = any) */
    allowedDomains: list('MAIL_ALLOWED_DOMAINS'),
    graphProcessedFolder: opt('GRAPH_PROCESSED_FOLDER', ''),
    gmail: {
      /** service_account (domain-wide delegation) | oauth (refresh token for the help desk mailbox only) */
      auth: opt('GMAIL_AUTH', 'service_account') as 'service_account' | 'oauth',
      serviceAccountKeyFile: opt('GOOGLE_SERVICE_ACCOUNT_KEY_FILE'),
      serviceAccountJson: opt('GOOGLE_SERVICE_ACCOUNT_JSON'),
      oauthClientId: opt('GMAIL_OAUTH_CLIENT_ID'),
      oauthClientSecret: opt('GMAIL_OAUTH_CLIENT_SECRET'),
      oauthRefreshToken: opt('GMAIL_OAUTH_REFRESH_TOKEN'),
      /** Gmail label applied to processed messages (created automatically) */
      processedLabel: opt('GMAIL_PROCESSED_LABEL', 'Helpdesk/Processed'),
      /** Remove processed messages from the Inbox (archive) */
      archive: opt('GMAIL_ARCHIVE', 'true') === 'true',
      /** Extra Gmail search terms for which inbox messages to import */
      query: opt('GMAIL_QUERY', ''),
    },
    imap: {
      host: opt('IMAP_HOST'),
      port: Number(opt('IMAP_PORT', '993')),
      secure: opt('IMAP_SECURE', 'true') === 'true',
      user: opt('IMAP_USER'),
      pass: opt('IMAP_PASS'),
      mailbox: opt('IMAP_MAILBOX', 'INBOX'),
    },
    smtp: {
      host: opt('SMTP_HOST'),
      port: Number(opt('SMTP_PORT', '587')),
      secure: opt('SMTP_SECURE', 'false') === 'true',
      user: opt('SMTP_USER'),
      pass: opt('SMTP_PASS'),
    },
  },
};

export const entraAuthority = () => `https://login.microsoftonline.com/${config.entra.tenantId}`;
