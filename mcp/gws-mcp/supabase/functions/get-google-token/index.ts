// @ts-ignore
import { createClient } from "npm:@supabase/supabase-js@2";

declare const Deno: any;

const corsHeaders = {
    "Access-Control-Allow-Origin": "https://assistant.b-p.co.jp",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json",
};

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
        // =============================
        // 1. JWT必須
        // =============================
        const authHeader = req.headers.get("Authorization");
        if (!authHeader?.startsWith("Bearer ")) {
            return new Response(
                JSON.stringify({ error: "Missing Authorization header" }),
                { status: 401, headers: corsHeaders }
            );
        }

        const accessToken = authHeader.replace("Bearer ", "").trim();

        const supabase = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_ANON_KEY")!
        );

        const {
            data: { user },
            error: userError,
        } = await supabase.auth.getUser(accessToken);

        if (userError || !user) {
            return new Response(
                JSON.stringify({ error: "Invalid user session" }),
                { status: 401, headers: corsHeaders }
            );
        }

        // =============================
        // 2. DBからrefresh_token取得
        // =============================
        const service = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );

        const { data, error } = await service
            .from("user_google_tokens")
            .select("refresh_token")
            .eq("user_id", user.id)
            .single();

        if (error || !data?.refresh_token) {
            return new Response(
                JSON.stringify({
                    error: "No refresh token stored",
                    code: "MISSING_REFRESH_TOKEN",
                }),
                { status: 409, headers: corsHeaders }
            );
        }

        const refreshToken = data.refresh_token;

        // =============================
        // 3. Google access_token発行
        // =============================
        const params = new URLSearchParams({
            client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
            client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
        });

        const googleRes = await fetch(
            "https://oauth2.googleapis.com/token",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: params,
            }
        );

        const googleJson = await googleRes.json();

        if (!googleRes.ok) {
            return new Response(
                JSON.stringify({
                    error: "Failed to refresh Google token",
                    detail: googleJson?.error,
                    reauthenticate: true,
                }),
                { status: 401, headers: corsHeaders }
            );
        }

        return new Response(
            JSON.stringify({
                access_token: googleJson.access_token,
                expires_in: googleJson.expires_in,
            }),
            { status: 200, headers: corsHeaders }
        );
    } catch (err) {
        console.error("get-google-token error:", err);
        return new Response(
            JSON.stringify({ error: "Internal server error" }),
            { status: 500, headers: corsHeaders }
        );
    }
});