/** Kick Sub Checker — Cloudflare Worker. */
import { utworzRepozytoriumD1 } from './d1-repository.js';

const KICK_AUTHORIZE_URL = 'https://id.kick.com/oauth/authorize';
const KICK_TOKEN_URL = 'https://id.kick.com/oauth/token';
const KICK_USERS_URL = 'https://api.kick.com/public/v1/users';
const KICK_PUBLIC_KEY_URL = 'https://api.kick.com/public/v1/public-key';
const KICK_EVENTS_URL = 'https://api.kick.com/public/v1/events/subscriptions';
const USERNAME_RE = /^[a-zA-Z0-9_]{1,25}$/;
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
const text = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

function base64UrlEncode(buffer) {
  const bytes = new Uint8Array(buffer); let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomString(length = 48) { const bytes = new Uint8Array(length); crypto.getRandomValues(bytes); return base64UrlEncode(bytes); }
async function sha256(value) { return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); }
async function hmac(value, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64UrlEncode(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let result = 0; for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i); return result === 0;
}
function bearerAuthorized(request, env) {
  const value = request.headers.get('Authorization') || '';
  return Boolean(env.BOT_API_SECRET && constantTimeEqual(value, `Bearer ${env.BOT_API_SECRET}`));
}
async function parseJsonResponse(response, label) {
  const raw = await response.text();
  let data; try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`${label}: odpowiedź API nie jest poprawnym JSON-em.`); }
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status} ${String(data.message || data.error || raw).slice(0, 300)}`);
  return data;
}
async function fetchKickPublicKey(env) {
  const cached = await env.SUBS_KV.get('kick:public_key');
  if (cached) return cached;
  const response = await fetch(KICK_PUBLIC_KEY_URL);
  const data = await parseJsonResponse(response, 'Pobieranie klucza publicznego Kick');
  const pem = data.public_key || data.data?.public_key;
  if (typeof pem !== 'string' || !pem.includes('BEGIN PUBLIC KEY')) throw new Error('Kick API nie zwróciło poprawnego klucza publicznego.');
  await env.SUBS_KV.put('kick:public_key', pem, { expirationTtl: 3600 });
  return pem;
}
async function importRsaPublicKey(pem) {
  const body = pem.replace(/-----BEGIN PUBLIC KEY-----/, '').replace(/-----END PUBLIC KEY-----/, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  return crypto.subtle.importKey('spki', der.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}
async function verifyWebhookSignature(env, headers, rawBody) {
  const id = headers.get('Kick-Event-Message-Id');
  const timestamp = headers.get('Kick-Event-Message-Timestamp');
  const encodedSignature = headers.get('Kick-Event-Signature');
  if (!id || !timestamp || !encodedSignature) return false;
  const eventTime = Date.parse(timestamp);
  if (!Number.isFinite(eventTime) || Math.abs(Date.now() - eventTime) > 5 * 60 * 1000) return false;
  try {
    const key = await importRsaPublicKey(await fetchKickPublicKey(env));
    const signature = Uint8Array.from(atob(encodedSignature), c => c.charCodeAt(0));
    const payload = new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`);
    const valid = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, payload);
    if (!valid) return false;
    // Deduplikacja i zapis ID są wykonywane dopiero po udanym przetworzeniu payloadu.
    // Dzięki temu błąd zapisu nie blokuje ponownej dostawy tego samego webhooka.
    return { valid: true, id };
  } catch (error) { console.error('Weryfikacja webhooka nie powiodła się:', error.message); return false; }
}
function repozytorium(env) {
  return env.DB ? utworzRepozytoriumD1(env.DB) : null;
}
async function pobierzBroadcasterId(env) {
  const configured = String(env.KICK_BROADCASTER_ID || '').trim();
  if (/^[0-9]{1,32}$/.test(configured)) return configured;
  const stored = await env.SUBS_KV.get('config:broadcaster_id');
  if (stored && /^[0-9]{1,32}$/.test(stored)) return stored;
  throw new Error('Brak KICK_BROADCASTER_ID. Wykonaj autoryzację właściciela kanału.');
}
async function saveTokens(env, tokens) {
  if (!tokens?.access_token || !tokens?.refresh_token || !Number.isFinite(Number(tokens.expires_in))) throw new Error('Kick OAuth zwrócił niekompletne tokeny.');
  await env.SUBS_KV.put('ljay:tokens', JSON.stringify({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: Date.now() + Number(tokens.expires_in) * 1000 }));
}
async function getBroadcasterAccessToken(env) {
  const raw = await env.SUBS_KV.get('ljay:tokens', 'json');
  if (!raw) throw new Error('Brak tokenów właściciela kanału. Administrator musi wygenerować link przez /api/owner/start.');
  if (Date.now() < raw.expires_at - 60_000) return raw.access_token;
  const response = await fetch(KICK_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: raw.refresh_token, client_id: env.KICK_CLIENT_ID, client_secret: env.KICK_CLIENT_SECRET }) });
  const tokens = await parseJsonResponse(response, 'Odświeżanie tokenu Kick');
  await saveTokens(env, tokens); return tokens.access_token;
}
async function kickCurrentUser(accessToken) {
  const response = await fetch(KICK_USERS_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await parseJsonResponse(response, 'Pobieranie tożsamości Kick');
  const user = Array.isArray(data.data) ? data.data[0] : data.data;
  if (!user || !user.username || user.user_id == null) throw new Error('Nie udało się potwierdzić tożsamości konta Kick.');
  return { username: String(user.username), user_id: String(user.user_id) };
}
async function handleAuthorize(request, env) {
  if (request.method !== 'GET') return text('Method Not Allowed', 405);
  const url = new URL(request.url); const linkToken = url.searchParams.get('link_token'); const ownerToken = url.searchParams.get('owner_token');
  let linkDiscordId = null; let ownerFlow = false;
  if (linkToken && ownerToken) return text('Nieprawidłowe parametry OAuth.', 400);
  if (linkToken) {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(linkToken)) return text('Nieprawidłowy lub wygasły link łączenia kont.', 403);
    const pendingLink = await env.SUBS_KV.get(`link-start:${linkToken}`, 'json');
    if (!pendingLink || !/^\d{17,20}$/.test(String(pendingLink.discord_id || ''))) return text('Link łączenia kont wygasł lub został już użyty. Uruchom /polacz-konto ponownie.', 403);
    await env.SUBS_KV.delete(`link-start:${linkToken}`);
    linkDiscordId = String(pendingLink.discord_id);
  } else if (ownerToken) {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(ownerToken) || !await env.SUBS_KV.get(`owner-start:${ownerToken}`)) return text('Link administracyjny wygasł lub został już użyty.', 403);
    await env.SUBS_KV.delete(`owner-start:${ownerToken}`);
    ownerFlow = true;
  } else {
    return text('Aby połączyć konto widza, użyj /polacz-konto na Discordzie. Autoryzację właściciela kanału uruchamia administrator.', 403);
  }
  const verifier = randomString(64); const challenge = base64UrlEncode(await sha256(verifier)); const state = randomString(24);
  await env.SUBS_KV.put(`oauth:state:${state}`, JSON.stringify({ verifier, discord_id: linkDiscordId, owner: ownerFlow, created_at: Date.now() }), { expirationTtl: 600 });
  const params = new URLSearchParams({ response_type: 'code', client_id: env.KICK_CLIENT_ID, redirect_uri: env.REDIRECT_URI, scope: 'user:read channel:read events:subscribe', code_challenge: challenge, code_challenge_method: 'S256', state });
  return Response.redirect(`${KICK_AUTHORIZE_URL}?${params}`, 302);
}
async function handleCallback(request, env) {
  const url = new URL(request.url); const code = url.searchParams.get('code'); const state = url.searchParams.get('state');
  if (!code || !state) return text('Brak kodu OAuth lub parametru state.', 400);
  const stateKey = `oauth:state:${state}`; const pending = await env.SUBS_KV.get(stateKey, 'json');
  if (!pending || Date.now() - pending.created_at > 10 * 60 * 1000) return text('Link wygasł lub jest nieprawidłowy. Uruchom łączenie kont ponownie.', 400);
  await env.SUBS_KV.delete(stateKey);
  const response = await fetch(KICK_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: env.KICK_CLIENT_ID, client_secret: env.KICK_CLIENT_SECRET, redirect_uri: env.REDIRECT_URI, code, code_verifier: pending.verifier }) });
  let tokens;
  try { tokens = await parseJsonResponse(response, 'Wymiana kodu OAuth'); } catch (error) { console.error(error.message); return text('Nie udało się zakończyć autoryzacji Kick. Spróbuj ponownie.', 502); }
  if (pending.discord_id) {
    try {
      const user = await kickCurrentUser(tokens.access_token);
      const username = user.username.toLowerCase();
      if (!USERNAME_RE.test(username)) return text('Kick zwrócił nieobsługiwany nick. Skontaktuj się z administratorem.', 400);
      const record = { discord_id: pending.discord_id, username, kick_user_id: user.user_id, linked_at: new Date().toISOString() };
      const repo = repozytorium(env);
      if (repo) {
        const broadcasterId = await pobierzBroadcasterId(env);
        try {
          await repo.polaczKonto({
            broadcasterId, discordUserId: pending.discord_id,
            kickUserId: user.user_id, kickUsername: username,
          });
        } catch (error) {
          if (/UNIQUE|constraint/i.test(error.message)) return text('To konto Kick jest już połączone z innym kontem Discord na tym kanale.', 409);
          throw error;
        }
      } else {
        const previous = await env.SUBS_KV.get(`link:discord:${pending.discord_id}`, 'json');
        const existing = await env.SUBS_KV.get(`link:kick:${username}`, 'json');
        if (existing && existing.discord_id !== pending.discord_id) return text('To konto Kick jest już połączone z innym kontem Discord. Skontaktuj się z administratorem.', 409);
        if (previous?.username && previous.username.toLowerCase() !== username) await env.SUBS_KV.delete(`link:kick:${previous.username.toLowerCase()}`);
        await env.SUBS_KV.put(`link:discord:${pending.discord_id}`, JSON.stringify(record));
        await env.SUBS_KV.put(`link:kick:${username}`, JSON.stringify(record));
      }
      return text(`Połączono konto Kick @${username}. Możesz wrócić na Discorda; rola zostanie zsynchronizowana w ciągu 10 minut.`);
    } catch (error) { console.error('Błąd łączenia konta Kick:', error.message); return text('Nie udało się zweryfikować konta Kick. Spróbuj ponownie.', 502); }
  }
  if (!pending.owner) return text('Nieprawidłowy przepływ OAuth. Uruchom autoryzację ponownie.', 400);
  try {
    // Zachowujemy istniejące klucze tokenów w KV — migracja D1 nie wymaga ponownego OAuth.
    await saveTokens(env, tokens);
    const owner = await kickCurrentUser(tokens.access_token);
    await env.SUBS_KV.put('config:broadcaster_id', owner.user_id);
    const repo = repozytorium(env);
    if (repo) await repo.zapiszKanal({ broadcasterId: owner.user_id, username: owner.username });
  } catch (error) {
    console.error('Zapis autoryzacji właściciela:', error.message);
    return text('Kick autoryzował aplikację, ale zapis konfiguracji kanału się nie powiódł. Tokeny pozostają w KV; ponów próbę konfiguracji bez ponownego OAuth.', 500);
  }
  return text('Autoryzacja właściciela kanału zakończona. Tokeny pozostają w KV. Administrator może teraz zarejestrować webhooki.');
}
async function handleRegisterEvents(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  if (!bearerAuthorized(request, env)) return json({ error: 'unauthorized' }, 401);
  try {
    const accessToken = await getBroadcasterAccessToken(env);
    const response = await fetch(KICK_EVENTS_URL, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ events: [{ name: 'channel.subscription.new', version: 1 }, { name: 'channel.subscription.renewal', version: 1 }, { name: 'channel.subscription.gifts', version: 1 }], method: 'webhook' }) });
    const raw = await response.text();
    return new Response(raw, { status: response.status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  } catch (error) { console.error('Rejestracja webhooków:', error.message); return json({ error: 'registration_failed', message: error.message }, 502); }
}
async function handleWebhook(request, env) {
  if (request.method !== 'POST') return text('Method Not Allowed', 405);
  const rawBody = await request.text();
  if (rawBody.length > 256_000) return text('Payload Too Large', 413);
  const verification = await verifyWebhookSignature(env, request.headers, rawBody);
  if (!verification || verification.valid !== true) return text('Invalid signature or stale event', 401);

  let payload;
  try { payload = JSON.parse(rawBody); } catch { return text('Invalid JSON', 400); }
  const eventType = request.headers.get('Kick-Event-Type') || 'unknown';
  const repo = repozytorium(env);
  const broadcasterId = repo ? await pobierzBroadcasterId(env) : null;
  const seenKey = `webhook:seen:${verification.id}`;

  if (repo) {
    const przejety = await repo.przejmijWebhook({ broadcasterId, eventId: verification.id, eventType });
    if (!przejety) return text('Duplicate event', 200);
    try {
      const subscriptions = [];
      const validExpiry = typeof payload?.expires_at === 'string' && Number.isFinite(Date.parse(payload.expires_at));
      const expiresAtMs = validExpiry ? Date.parse(payload.expires_at) : null;
      if (eventType === 'channel.subscription.new' || eventType === 'channel.subscription.renewal') {
        const subscriber = payload?.subscriber;
        if (!subscriber || typeof subscriber.username !== 'string' || !USERNAME_RE.test(subscriber.username) || !validExpiry) {
          throw new Error('Invalid subscription payload');
        }
        subscriptions.push({
          kickUserId: subscriber.user_id == null ? null : String(subscriber.user_id),
          kickUsername: subscriber.username, expiresAtMs, source: eventType,
        });
      } else if (eventType === 'channel.subscription.gifts') {
        const giftees = payload?.giftees;
        if (!Array.isArray(giftees) || !giftees.length || !validExpiry || giftees.length > 500) {
          throw new Error('Invalid gifted subscription payload');
        }
        for (const giftee of giftees) {
          if (typeof giftee?.username !== 'string' || !USERNAME_RE.test(giftee.username)) continue;
          subscriptions.push({
            kickUserId: giftee.user_id == null ? null : String(giftee.user_id),
            kickUsername: giftee.username, expiresAtMs, source: eventType,
          });
        }
      }
      await repo.zakonczWebhook({ broadcasterId, eventId: verification.id, subscriptions });
      return text('OK');
    } catch (error) {
      await repo.oznaczWebhookNieudany({ broadcasterId, eventId: verification.id }).catch((markError) => {
        console.error('Nie udało się oznaczyć webhooka jako failed:', markError.message);
      });
      console.error('Błąd przetwarzania webhooka D1:', error.message);
      return text('Webhook processing failed', 500);
    }
  }

  if (await env.SUBS_KV.get(seenKey)) return text('Duplicate event', 200);
  const validExpiry = typeof payload?.expires_at === 'string' && Number.isFinite(Date.parse(payload.expires_at));
  const expiryIso = validExpiry ? new Date(payload.expires_at).toISOString() : null;
  if (eventType === 'channel.subscription.new' || eventType === 'channel.subscription.renewal') {
    const subscriber = payload?.subscriber;
    if (typeof subscriber?.username !== 'string' || !USERNAME_RE.test(subscriber.username) || !validExpiry) {
      return text('Invalid subscription payload', 400);
    }
    await saveSubscription(env, { username: subscriber.username, user_id: subscriber.user_id, expires_at: expiryIso, source: eventType });
  } else if (eventType === 'channel.subscription.gifts') {
    const giftees = payload?.giftees;
    if (!Array.isArray(giftees) || !giftees.length || !validExpiry) return text('Invalid gifted subscription payload', 400);
    for (const giftee of giftees) {
      if (typeof giftee?.username !== 'string' || !USERNAME_RE.test(giftee.username)) continue;
      await saveSubscription(env, { username: giftee.username, user_id: giftee.user_id, expires_at: expiryIso, source: eventType });
    }
  }
  await env.SUBS_KV.put(seenKey, '1', { expirationTtl: 86400 });
  return text('OK');
}

async function saveSubscription(env, subscription) {
  const username = subscription.username.trim();
  const key = `sub:${username.toLowerCase()}`;
  const old = await env.SUBS_KV.get(key, 'json');
  const record = {
    user_id: String(subscription.user_id ?? ''),
    username,
    expires_at: subscription.expires_at,
    source: subscription.source,
    updated_at: new Date().toISOString(),
  };
  // Eventy mogą dotrzeć poza kolejnością; nie cofamy późniejszej daty wygaśnięcia.
  if (!old || !Number.isFinite(Date.parse(old.expires_at)) || Date.parse(record.expires_at) >= Date.parse(old.expires_at)) {
    await env.SUBS_KV.put(key, JSON.stringify(record));
  }
}

async function handleApi(request, env) {
  if (!bearerAuthorized(request, env)) return json({ error: 'unauthorized' }, 401);
  const url = new URL(request.url);
  if (url.pathname === '/api/check') {
    const username = (url.searchParams.get('username') || '').replace(/^@/, '').trim();
    if (!USERNAME_RE.test(username)) return json({ error: 'invalid_username' }, 400);
    const repo = repozytorium(env);
    if (repo) {
      const status = await repo.sprawdzSubskrypcje({ broadcasterId: await pobierzBroadcasterId(env), kickUsername: username });
      return json({
        username: status.username || username, status: status.status, subscribed: status.subscribed,
        expires_at: status.expires_at_ms ? new Date(status.expires_at_ms).toISOString() : null,
      });
    }
    const record = await env.SUBS_KV.get(`sub:${username.toLowerCase()}`, 'json');
    const expiry = record ? Date.parse(record.expires_at) : NaN;
    if (!record || !Number.isFinite(expiry)) {
      return json({ username: record?.username || username, status: 'unknown', subscribed: null, expires_at: record?.expires_at || null });
    }
    const subscribed = expiry > Date.now();
    return json({ username: record.username || username, status: subscribed ? 'active' : 'inactive', subscribed, expires_at: record.expires_at });
  }
  if (url.pathname === '/api/owner/start') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    const ownerToken = randomString(32);
    await env.SUBS_KV.put(`owner-start:${ownerToken}`, '1', { expirationTtl: 600 });
    return json({ url: `${url.origin}/authorize?${new URLSearchParams({ owner_token: ownerToken })}` });
  }
  if (url.pathname === '/api/link/start') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    let body; try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    const discordId = String(body.discord_id || '');
    if (!/^\d{17,20}$/.test(discordId)) return json({ error: 'invalid_discord_id' }, 400);
    const linkToken = randomString(32);
    await env.SUBS_KV.put(`link-start:${linkToken}`, JSON.stringify({ discord_id: discordId, created_at: Date.now() }), { expirationTtl: 600 });
    return json({ url: `${url.origin}/authorize?${new URLSearchParams({ link_token: linkToken })}` });
  }
  if (url.pathname === '/api/link') {
    const discordId = url.searchParams.get('discord_id') || '';
    if (!/^\d{17,20}$/.test(discordId)) return json({ error: 'invalid_discord_id' }, 400);
    const repo = repozytorium(env);
    if (repo) {
      const record = await repo.pobierzPowiazanie({ broadcasterId: await pobierzBroadcasterId(env), discordUserId: discordId });
      return json({ username: record?.kick_username || null, linked_at: record?.linked_at_ms ? new Date(record.linked_at_ms).toISOString() : null });
    }
    const record = await env.SUBS_KV.get(`link:discord:${discordId}`, 'json');
    return json({ username: record?.username || null, linked_at: record?.linked_at || null });
  }
  if (url.pathname === '/api/links') {
    const repo = repozytorium(env);
    if (repo) {
      const links = await repo.pobierzPowiazania({ broadcasterId: await pobierzBroadcasterId(env), limit: 1000 });
      return json({ links: links.map((record) => ({ discord_id: record.discord_user_id, username: record.kick_username })) });
    }
    const links = []; let cursor;
    do {
      const page = await env.SUBS_KV.list({ prefix: 'link:discord:', cursor, limit: 1000 });
      for (const key of page.keys) {
        const record = await env.SUBS_KV.get(key.name, 'json');
        if (record?.discord_id && record?.username) links.push({ discord_id: record.discord_id, username: record.username });
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return json({ links });
  }
  return json({ error: 'not_found' }, 404);
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/authorize') return handleAuthorize(request, env);
      if (url.pathname === '/callback') return handleCallback(request, env);
      if (url.pathname === '/webhook') return handleWebhook(request, env);
      if (url.pathname === '/register-events') return handleRegisterEvents(request, env);
      if (url.pathname.startsWith('/api/')) return handleApi(request, env);
      if (url.pathname === '/') return text('Kick Sub Checker Worker działa.');
      return text('Not Found', 404);
    } catch (error) {
      console.error('Worker error:', error.message);
      return url.pathname.startsWith('/api/') ? json({ error: 'internal_error' }, 500) : text('Wystąpił wewnętrzny błąd serwera.', 500);
    }
  },
};
