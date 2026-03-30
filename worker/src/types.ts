import type { StaffUser } from "./middleware/auth";

export type Env = {
  // Cloudflare bindings
  DB: D1Database;
  IMAGES: R2Bucket;

  // Supabase (staff auth + staff profiles)
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;

  // Asana
  ASANA_PAT: string;
  ASANA_BUG_PROJECT_GID: string;

  // Google Sheets (rental revenue sync)
  GOOGLE_SHEETS_CREDENTIALS?: string;

  // Brevo (email)
  BREVO_API_KEY: string;

  // App config
  APP_ENV: string;
  APP_SECRET_KEY: string;
  APP_BASE_URL: string;
  BUSINESS_OPEN_HOUR: string;
  BUSINESS_CLOSE_HOUR: string;
};

export type AppVariables = {
  staff: StaffUser;
};

/** Shorthand for Hono app type with our bindings and variables */
export type AppType = { Bindings: Env; Variables: AppVariables };
