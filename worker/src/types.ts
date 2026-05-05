import type { StaffUser } from "./middleware/auth";

export type Env = {
  // Cloudflare bindings
  DB: D1Database;
  IMAGES: R2Bucket;

  // Internal reviewer -> luggage auth
  INTERNAL_API_SECRET: string;

  // Supabase (staff auth + staff profiles)
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;

  // Asana
  ASANA_PAT: string;
  ASANA_BUG_PROJECT_GID: string;

  // Google Sheets (luggage daily sales sync)
  GOOGLE_SHEETS_CREDENTIALS?: string;

  // Naver Orders Supabase (rental revenue sync)
  NAVER_ORDERS_SUPABASE_URL?: string;
  NAVER_ORDERS_SUPABASE_KEY?: string;

  // Brevo (email)
  BREVO_API_KEY: string;

  // Browser observability for customer pages
  SENTRY_BROWSER_DSN?: string;
  SENTRY_RELEASE?: string;
  CLARITY_PROJECT_ID?: string;

  // App config
  APP_ENV: string;
  APP_SECRET_KEY: string;
  APP_BASE_URL: string;
  DEV_STAFF_AUTH_BYPASS?: string;
  SYNC_JOBS_ENABLED?: string;
  BUSINESS_OPEN_HOUR: string;
  BUSINESS_CLOSE_HOUR: string;
};

export type AppVariables = {
  staff: StaffUser;
  rawBody?: ArrayBuffer;
};

/** Shorthand for Hono app type with our bindings and variables */
export type AppType = { Bindings: Env; Variables: AppVariables };
