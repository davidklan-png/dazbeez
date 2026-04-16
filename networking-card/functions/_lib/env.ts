export interface Env {
  DB: D1Database;
  GOOGLE_CLIENT_ID: string;
  LINKEDIN_CLIENT_ID: string;
  LINKEDIN_CLIENT_SECRET: string;
  RESEND_API_KEY: string;
  DISCORD_WEBHOOK_URL: string;
  DISABLE_OUTBOUND_NOTIFICATIONS?: string;
  ADMIN_API_KEY?: string;
}
