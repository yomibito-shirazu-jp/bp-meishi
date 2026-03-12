// @ts-ignore
import { createClient } from "npm:@supabase/supabase-js@2";

declare const Deno: any;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Content-Type": "application/json",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      console.info("exchange-google-code: NO_AUTH_HEADER");
      return new Response(JSON.stringify({ error: "Unauthorized", code: "NO_AUTH_HEADER" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace(/^Bearer\s+/i, "");
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userErr } = await userClient.auth.getUser(token);
    if (userErr || !user) {
      console.info("exchange-google-code: INVALID_SESSION", userErr?.message ?? "getUser null");
      return new Response(JSON.stringify({ error: "Invalid session", code: "INVALID_SESSION" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let body: { code?: string; redirect_uri?: string; refresh_token?: string; code_verifier?: string } = {};
    try {
      body = await req.json() || {};
      console.log("[exchange-google-code] Request body:", {
        has_code: !!body.code,
        has_refresh_token: !!body.refresh_token,
        has_redirect_uri: !!body.redirect_uri,
        has_code_verifier: !!body.code_verifier
      });
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body", code: "INVALID_BODY" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let refreshToken = body.refresh_token;

    if (!refreshToken) {
      const code = body?.code?.trim();
      const codeVerifier = body?.code_verifier?.trim();
      if (!code) {
        console.info("exchange-google-code: MISSING_CODE");
        return new Response(JSON.stringify({ error: "code or refresh_token required", code: "MISSING_PARAMS" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const redirectUri = body?.redirect_uri?.trim() || Deno.env.get("GOOGLE_REDIRECT_URI") || "";
      console.log("[exchange-google-code] Using redirect_uri:", redirectUri);
      if (!redirectUri) {
        console.info("exchange-google-code: MISSING_REDIRECT_URI");
        return new Response(JSON.stringify({ error: "redirect_uri required", code: "MISSING_REDIRECT_URI" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
      const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

      const tokenParams = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      });

      if (codeVerifier) {
        tokenParams.append('code_verifier', codeVerifier);
      }

      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenParams,
      });

      const tokenJson = await tokenRes.json();

      if (!tokenRes.ok) {
        console.error("[exchange-google-code] Google exchange error:", tokenJson);
        console.info("exchange-google-code: GOOGLE_TOKEN_EXCHANGE_FAILED", tokenJson?.error ?? "unknown", "detail:", tokenJson?.error_description ?? "");
        return new Response(JSON.stringify({ error: "Google token exchange failed", code: "GOOGLE_TOKEN_EXCHANGE_FAILED", reauthenticate: true }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      refreshToken = tokenJson.refresh_token;
      console.log("[exchange-google-code] Got refresh_token from Google:", !!refreshToken);
    }

    if (!refreshToken) {
      console.info("exchange-google-code: NO_REFRESH_TOKEN from Google");
      return new Response(JSON.stringify({ error: "Google did not return refresh_token. Use prompt=consent.", code: "NO_REFRESH_TOKEN", reauthenticate: true }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const serviceRoleClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    console.log("[exchange-google-code] Upserting token for user:", user.id);

    const { error: upsertErr } = await serviceRoleClient
      .from("user_google_tokens")
      .upsert(
        { user_id: user.id, refresh_token: refreshToken, updated_at: new Date().toISOString() },
        { onConflict: "user_id" }
      );

    if (upsertErr) {
      console.error("exchange-google-code: upsert failed", upsertErr);
      return new Response(JSON.stringify({ error: "Failed to save token", code: "UPSERT_FAILED" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("[exchange-google-code] Token saved successfully");

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("exchange-google-code error:", e?.message || e);
    return new Response(JSON.stringify({ error: "Internal error", code: "UNHANDLED" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
