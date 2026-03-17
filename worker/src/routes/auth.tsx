import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppType } from "../types";
import { createSupabaseClient } from "../lib/supabase";
import { setSession, clearSession } from "../middleware/auth";

const auth = new Hono<AppType>();

// Staff login page
auth.get("/staff/login", (c) => {
  const error = c.req.query("error") || "";

  return c.html(
    <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Staff Login - Flying Japan Luggage</title>
        <link rel="stylesheet" href="/static/styles.css" />
      </head>
      <body class="staff-site">
        <div class="login-page">
          <div class="login-card">
            <div class="login-header">
              <img class="login-logo" src="/static/logo-horizontal.png" alt="Flying Japan" width="52" height="52" />
              <h2 class="login-title">Staff Login</h2>
              <p class="login-subtitle">Flying Japan 직원 전용 콘솔</p>
            </div>

            {error && <p class="error">{error}</p>}

            <a class="btn btn-google btn-lg" href="/auth/google">
              <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
                <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
                <path d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z" fill="#FBBC05"/>
                <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 6.293C4.672 4.166 6.656 3.58 9 3.58z" fill="#EA4335"/>
              </svg>
              Google로 로그인
            </a>

            <div class="login-divider"><span>또는</span></div>

            <form action="/staff/login" method="post">
              <label class="field">
                <span class="field-label">이메일</span>
                <input class="control" type="email" name="email" required autocomplete="email" placeholder="name@flyingjp.com" />
              </label>

              <label class="field">
                <span class="field-label">비밀번호</span>
                <input class="control" type="password" name="password" required autocomplete="current-password" />
              </label>

              <button class="btn btn-primary btn-lg" type="submit">로그인</button>
            </form>

            <a class="login-customer-link" href="/customer">고객 접수화면으로 이동</a>
          </div>
        </div>
      </body>
    </html>
  );
});

// Staff login handler (email/password via Supabase Auth)
auth.post("/staff/login", async (c) => {
  const body = await c.req.parseBody();
  const email = String(body.email || "").trim();
  const password = String(body.password || "");

  if (!email || !password) {
    return c.redirect("/staff/login?error=Email and password required");
  }

  const supabase = createSupabaseClient(c.env);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.user) {
    return c.redirect(`/staff/login?error=${encodeURIComponent(error?.message || "Login failed")}`);
  }

  // Check user exists in D1 user_profiles and is active
  const profile = await c.env.DB.prepare(
    "SELECT id, is_active, role FROM user_profiles WHERE id = ?"
  )
    .bind(data.user.id)
    .first<{ id: string; is_active: number; role: string }>();

  if (!profile || !profile.is_active) {
    return c.redirect("/staff/login?error=Account not active");
  }

  setSession(c, data.user.id);
  return c.redirect("/staff/dashboard");
});

// Staff logout
auth.post("/staff/logout", (c) => {
  clearSession(c);
  return c.redirect("/staff/login");
});

// Also support GET logout for convenience
auth.get("/staff/logout", (c) => {
  clearSession(c);
  return c.redirect("/staff/login");
});

// Google OAuth: initiate PKCE flow (matching original FastAPI implementation)
auth.get("/auth/google", async (c) => {
  // Generate PKCE code_verifier and code_challenge
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const codeVerifier = btoa(String.fromCharCode(...verifierBytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const challengeBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier)
  );
  const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(challengeBytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  // Store code_verifier in a short-lived cookie (used in callback)
  setCookie(c, "oauth_code_verifier", codeVerifier, {
    httpOnly: true,
    secure: c.env.APP_ENV === "production",
    sameSite: "Lax",
    maxAge: 600, // 10 minutes
    path: "/",
  });

  const baseUrl = c.env.APP_BASE_URL || "";
  const params = new URLSearchParams({
    provider: "google",
    redirect_to: `${baseUrl}/auth/callback`,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    flow_type: "pkce",
  });

  return c.redirect(`${c.env.SUPABASE_URL}/auth/v1/authorize?${params.toString()}`);
});

// Google OAuth: callback (PKCE token exchange)
auth.get("/auth/callback", async (c) => {
  const code = c.req.query("code");
  const errorParam = c.req.query("error");

  if (errorParam || !code) {
    return c.redirect(`/staff/login?error=${encodeURIComponent(errorParam || "oauth_failed")}`);
  }

  const codeVerifier = getCookie(c, "oauth_code_verifier");
  if (!codeVerifier) {
    return c.redirect("/staff/login?error=state_missing");
  }

  // Clear the verifier cookie
  deleteCookie(c, "oauth_code_verifier", { path: "/" });

  // Exchange code for token using Supabase token endpoint
  const tokenResp = await fetch(`${c.env.SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    headers: {
      "apikey": c.env.SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ auth_code: code, code_verifier: codeVerifier }),
  });

  if (!tokenResp.ok) {
    return c.redirect("/staff/login?error=exchange_failed");
  }

  const tokenData = await tokenResp.json() as { user?: { id?: string } };
  const userId = tokenData.user?.id;
  if (!userId) {
    return c.redirect("/staff/login?error=no_user");
  }

  // Check user exists in D1 user_profiles and is active
  const profile = await c.env.DB.prepare(
    "SELECT id, is_active FROM user_profiles WHERE id = ?"
  )
    .bind(String(userId))
    .first<{ id: string; is_active: number }>();

  if (!profile || !profile.is_active) {
    return c.redirect("/staff/login?error=access_denied");
  }

  setSession(c, String(userId));
  return c.redirect("/staff/dashboard");
});

export default auth;
