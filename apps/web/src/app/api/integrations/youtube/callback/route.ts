import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const officeId = searchParams.get('state');

  if (!code || !officeId) {
    return NextResponse.redirect(`${origin}/app?error=youtube_oauth_missing_params`);
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = `${origin}/api/integrations/youtube/callback`;

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(
      `${origin}/app/offices/${officeId}?error=youtube_oauth_not_configured`,
    );
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      return NextResponse.redirect(
        `${origin}/app/offices/${officeId}?error=youtube_token_exchange_failed`,
      );
    }

    const tokenJson = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
    };

    const refreshToken = tokenJson.refresh_token;
    const accessToken = tokenJson.access_token;
    if (!refreshToken || !accessToken) {
      return NextResponse.redirect(
        `${origin}/app/offices/${officeId}?error=youtube_refresh_token_missing`,
      );
    }

    let channelId = 'UC_workoffice_channel';
    let channelTitle = 'Canal Conectado YouTube';

    const chanRes = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    if (chanRes.ok) {
      const chanJson = (await chanRes.json()) as {
        items?: { id?: string; snippet?: { title?: string } }[];
      };
      const first = chanJson.items?.[0];
      if (first?.id) channelId = first.id;
      if (first?.snippet?.title) channelTitle = first.snippet.title;
    }

    const supabase = await createSupabaseServerClient();
    await supabase.rpc('store_office_youtube_integration', {
      p_office_id: officeId,
      p_refresh_token: refreshToken,
      p_channel_id: channelId,
      p_channel_title: channelTitle,
      p_scopes: [
        'https://www.googleapis.com/auth/youtube.upload',
        'https://www.googleapis.com/auth/yt-analytics.readonly',
      ],
    });

    return NextResponse.redirect(`${origin}/app/offices/${officeId}?youtube=connected`);
  } catch {
    return NextResponse.redirect(
      `${origin}/app/offices/${officeId}?error=youtube_oauth_unexpected`,
    );
  }
}
