import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const YOUTUBE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  const { searchParams, origin } = new URL(request.url);
  const officeId = searchParams.get('officeId') ?? '';

  if (!officeId) {
    return NextResponse.json({ error: 'Informe o officeId.' }, { status: 400 });
  }

  const { data: integration, error } = await supabase
    .from('office_integrations')
    .select('id, office_id, provider, channel_id, metadata, created_at')
    .eq('office_id', officeId)
    .eq('provider', 'youtube')
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const redirectUri = `${origin}/api/integrations/youtube/callback`;
  const authorizeUrl = clientId
    ? `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        access_type: 'offline',
        prompt: 'consent',
        scope: YOUTUBE_OAUTH_SCOPES.join(' '),
        state: officeId,
      }).toString()}`
    : null;

  return NextResponse.json({
    integration: integration ?? null,
    oauthAuthorizeUrl: authorizeUrl,
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  const body = await request.json();
  const officeId = String(body.officeId ?? '').trim();
  const channelId = String(body.channelId ?? '').trim();
  const channelTitle = String(body.channelTitle ?? channelId).trim();
  const refreshToken = String(body.refreshToken ?? '').trim();

  if (!officeId || !channelId || refreshToken.length < 10) {
    return NextResponse.json(
      { error: 'Informe officeId, channelId e um refreshToken OAuth válido.' },
      { status: 400 },
    );
  }

  const { data, error } = await supabase.rpc('store_office_youtube_integration', {
    p_office_id: officeId,
    p_refresh_token: refreshToken,
    p_channel_id: channelId,
    p_channel_title: channelTitle,
    p_scopes: YOUTUBE_OAUTH_SCOPES,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ integration: data }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const officeId = searchParams.get('officeId') ?? '';

  if (!officeId) {
    return NextResponse.json({ error: 'Informe o officeId.' }, { status: 400 });
  }

  const { error } = await supabase.rpc('revoke_office_youtube_integration', {
    p_office_id: officeId,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ revoked: true });
}
