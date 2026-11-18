/** Kick Sub Checker — Cloudflare Worker. */
import { utworzRepozytoriumD1 } from './d1-repository.js';
import { pobierzTokenMigracji } from './kv-migrator.js';
import { walidujBroadcasteraWebhooka, walidujIdSubskrypcjiWebhooka, walidujTypIWersjeWebhooka, walidujWynikRejestracjiWebhookow } from './webhook-validation.js';
export { OAuthTokenStore } from './oauth-token-store.js';

const TOKEN_TTL_MS = 10 * 60 * 1000;
function magazynTokenow(env, token) {
  if (!env.OAUTH_TOKENS || typeof env.OAUTH_TOKENS.getByName !== 'function') {
    throw new Error('Brak bindingu OAUTH_TOKENS — wymagane wdrożenie migracji Durable Object.');
  }
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(token)) {
    throw new Error('Nieprawidłowy token jednorazowy.');
  }
  return env.OAUTH_TOKENS.getByName(`token-${token[0]}`);
}
async function zapiszTokenJednorazowy(env, token, typ, dane) {
  return magazynTokenow(env, token).zapisz(token, typ, dane, Date.now() + TOKEN_TTL_MS);
}
async function zuzyjTokenJednorazowy(env, token, typ) {
  return magazynTokenow(env, token).zuzyj(token, typ);
}
async function zarezerwujTokenOAuth(env, token) {
  return magazynTokenow(env, token).zarezerwuj(token, 'oauth-state', 120_000);
}
async function zakonczTokenOAuth(env, token, rezerwacjaId) {
  return magazynTokenow(env, token).zakoncz(token, 'oauth-state', rezerwacjaId);
}
async function zwolnijTokenOAuth(env, token, rezerwacjaId) {
  return magazynTokenow(env, token).zwolnij(token, 'oauth-state', rezerwacjaId);
}

const KICK_AUTHORIZE_URL = 'https://id.kick.com/oauth/authorize';
const KICK_TOKEN_URL = 'https://id.kick.com/oauth/token';
const KICK_USERS_URL = 'https://api.kick.com/public/v1/users';
const KICK_PUBLIC_KEY_URL = 'https://api.kick.com/public/v1/public-key';
const KICK_EVENTS_URL = 'https://api.kick.com/public/v1/events/subscriptions';
const USERNAME_RE = /^[a-zA-Z0-9_-]{1,25}$/;
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
const text = (body, status = 200, extra = {}) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });

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
async function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const encoder = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  // Workers ma natywne timingSafeEqual; fallback Node zachowuje stałą długość porównania.
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(hashA, hashB);
  }
  const bytesA = new Uint8Array(hashA);
  const bytesB = new Uint8Array(hashB);
  let roznica = 0;
  for (let i = 0; i < bytesA.length; i++) roznica |= bytesA[i] ^ bytesB[i];
  return roznica === 0;
}
async function bearerAuthorized(request, env) {
  const sekret = env.BOT_API_SECRET;
  if (typeof sekret !== 'string' || !sekret) return false;
  const value = request.headers.get('Authorization') || '';
  return constantTimeEqual(value, `Bearer ${sekret}`);
}
async function adminBearerAuthorized(request, env) {
  const sekret = env.ADMIN_API_SECRET;
  if (typeof sekret !== 'string' || !sekret) return false;
  const sekretBota = env.BOT_API_SECRET;
  if (
    typeof sekretBota === 'string' && sekretBota
    && await constantTimeEqual(sekret, sekretBota)
  ) return false;
  const value = request.headers.get('Authorization') || '';
  return constantTimeEqual(value, `Bearer ${sekret}`);
}
async function parseJsonResponse(response, label) {
  const raw = await response.text();
  let data; try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`${label}: odpowiedź API nie jest poprawnym JSON-em.`); }
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  return data;
}
async function fetchKickPublicKey(env) {
  const cached = await env.SUBS_KV.get('kick:public_key');
  if (cached) return cached;
  const response = await fetch(KICK_PUBLIC_KEY_URL, { signal: AbortSignal.timeout(10_000) });
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
  if (!id || !/^[A-Za-z0-9._:-]{1,200}$/.test(id) || !timestamp || !encodedSignature) return false;
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
function repozytorium(env, wymus = false) {
  return env.DB && (wymus || env.D1_ENABLED === 'true') ? utworzRepozytoriumD1(env.DB) : null;
}
function zapisyZamrozone(env) {
  return env.MIGRATION_WRITE_FREEZE === 'true';
}
function odpowiedzZamrozenia() {
  return text('Operacje zapisu są czasowo wstrzymane na czas migracji backendu. Spróbuj ponownie po zakończeniu przełączenia.', 503, { 'Retry-After': '120' });
}
async function pobierzBroadcasterId(env) {
  const configured = String(env.KICK_BROADCASTER_ID || '').trim();
  const stored = await env.SUBS_KV.get('config:broadcaster_id');
  if (stored && !/^[0-9]{1,32}$/.test(stored)) throw new Error('Zapisany ID kanału Kick jest nieprawidłowy.');
  if (configured && !/^[0-9]{1,32}$/.test(configured)) throw new Error('KICK_BROADCASTER_ID ma nieprawidłowy format.');
  if (stored && configured && stored !== configured) {
    throw new Error('KICK_BROADCASTER_ID nie zgadza się z autoryzowanym kanałem Kick.');
  }
  if (stored) {
    const repo = repozytorium(env);
    if (repo) {
      let username = await env.SUBS_KV.get('config:broadcaster_username');
      if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
        const owner = await kickCurrentUser(await getBroadcasterAccessToken(env));
        if (owner.user_id !== stored) throw new Error('Token OAuth należy do innego kanału Kick niż zapisany broadcaster ID.');
        username = owner.username;
        await env.SUBS_KV.put('config:broadcaster_username', username);
      }
      // Naprawia częściowy zapis KV→D1 po wcześniejszej awarii; operacja jest idempotentna.
      await repo.zapiszKanal({ broadcasterId: stored, username });
    }
    return stored;
  }

  // Przy pierwszej konfiguracji potwierdzamy ID przez autoryzowany token właściciela.
  const owner = await kickCurrentUser(await getBroadcasterAccessToken(env));
  if (configured && configured !== owner.user_id) {
    throw new Error('Token OAuth należy do innego kanału Kick niż KICK_BROADCASTER_ID.');
  }
  await env.SUBS_KV.put('config:broadcaster_id', owner.user_id);
  await env.SUBS_KV.put('config:broadcaster_username', owner.username);
  const repo = repozytorium(env);
  if (repo) await repo.zapiszKanal({ broadcasterId: owner.user_id, username: owner.username });
  return owner.user_id;
}
async function saveTokens(env, tokens) {
  const expiresIn = Number(tokens?.expires_in);
  if (typeof tokens?.access_token !== 'string' || !tokens.access_token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('Kick OAuth zwrócił niekompletne tokeny.');
  }
  const previous = await env.SUBS_KV.get('ljay:tokens', 'json');
  const refreshToken = typeof tokens.refresh_token === 'string' && tokens.refresh_token
    ? tokens.refresh_token
    : previous?.refresh_token;
  if (typeof refreshToken !== 'string' || !refreshToken) {
    throw new Error('Brak refresh_token w odpowiedzi Kicka i w zapisanych danych.');
  }
  await env.SUBS_KV.put('ljay:tokens', JSON.stringify({
    access_token: tokens.access_token,
    refresh_token: refreshToken,
    expires_at: Date.now() + expiresIn * 1000,
  }));
}
async function getBroadcasterAccessToken(env, timeoutMs = 10_000) {
  const raw = await env.SUBS_KV.get('ljay:tokens', 'json');
  if (!raw) throw new Error('Brak tokenów właściciela kanału. Administrator musi wygenerować link przez /api/owner/start.');
  if (Date.now() < raw.expires_at - 60_000) return raw.access_token;
  const opcje = {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: raw.refresh_token,
      client_id: env.KICK_CLIENT_ID, client_secret: env.KICK_CLIENT_SECRET,
    }),
  };
  if (timeoutMs > 0) opcje.signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(KICK_TOKEN_URL, opcje);
  const tokens = await parseJsonResponse(response, 'Odświeżanie tokenu Kick');
  await saveTokens(env, tokens); return tokens.access_token;
}
async function kickCurrentUser(accessToken, timeoutMs = 10_000) {
  const opcje = { headers: { Authorization: `Bearer ${accessToken}` } };
  if (timeoutMs > 0) opcje.signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(KICK_USERS_URL, opcje);
  const data = await parseJsonResponse(response, 'Pobieranie tożsamości Kick');
  const user = Array.isArray(data.data) ? data.data[0] : data.data;
  if (
    !user || typeof user.username !== 'string' || !USERNAME_RE.test(user.username)
    || user.user_id == null || !/^[0-9]{1,32}$/.test(String(user.user_id))
  ) throw new Error('Nie udało się potwierdzić poprawnej tożsamości konta Kick.');
  return { username: user.username, user_id: String(user.user_id) };
}
async function handleAuthorize(request, env) {
  if (zapisyZamrozone(env)) return odpowiedzZamrozenia();
  if (request.method !== 'GET') return text('Method Not Allowed', 405);
  const url = new URL(request.url); const linkToken = url.searchParams.get('link_token'); const ownerToken = url.searchParams.get('owner_token');
  let linkDiscordId = null; let ownerFlow = false;
  if (linkToken && ownerToken) return text('Nieprawidłowe parametry OAuth.', 400);
  if (linkToken) {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(linkToken)) return text('Nieprawidłowy lub wygasły link łączenia kont.', 403);
    const pendingLink = await zuzyjTokenJednorazowy(env, linkToken, 'link-start');
    if (!pendingLink || !/^\d{17,20}$/.test(String(pendingLink.discord_id || ''))) return text('Link łączenia kont wygasł lub został już użyty. Uruchom /polacz-konto ponownie.', 403);
    linkDiscordId = String(pendingLink.discord_id);
  } else if (ownerToken) {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(ownerToken) || !await zuzyjTokenJednorazowy(env, ownerToken, 'owner-start')) return text('Link administracyjny wygasł lub został już użyty.', 403);
    ownerFlow = true;
  } else {
    return text('Aby połączyć konto widza, użyj /polacz-konto na Discordzie. Autoryzację właściciela kanału uruchamia administrator.', 403);
  }
  const verifier = randomString(64); const challenge = base64UrlEncode(await sha256(verifier)); const state = randomString(24);
  await zapiszTokenJednorazowy(env, state, 'oauth-state', { verifier, discord_id: linkDiscordId, owner: ownerFlow, created_at: Date.now() });
  const params = new URLSearchParams({ response_type: 'code', client_id: env.KICK_CLIENT_ID, redirect_uri: env.REDIRECT_URI, scope: 'user:read channel:read events:subscribe', code_challenge: challenge, code_challenge_method: 'S256', state });
  return Response.redirect(`${KICK_AUTHORIZE_URL}?${params}`, 302);
}
async function handleCallback(request, env) {
  if (zapisyZamrozone(env)) return odpowiedzZamrozenia();
  const url = new URL(request.url);
  if (url.searchParams.has('error')) return text('Logowanie Kick zostało anulowane lub odrzucone. Uruchom autoryzację ponownie.', 400);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state || state.length > 200) return text('Brak kodu OAuth lub nieprawidłowy parametr state.', 400);
  const rezerwacja = await zarezerwujTokenOAuth(env, state);
  if (!rezerwacja || !rezerwacja.dane || Date.now() - rezerwacja.dane.created_at > TOKEN_TTL_MS) {
    return text('Link wygasł, jest nieprawidłowy lub autoryzacja jest już przetwarzana. Spróbuj ponownie za chwilę.', 400);
  }
  const pending = rezerwacja.dane;
  let tokens;
  try {
    const response = await fetch(KICK_TOKEN_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: env.KICK_CLIENT_ID,
        client_secret: env.KICK_CLIENT_SECRET, redirect_uri: env.REDIRECT_URI,
        code, code_verifier: pending.verifier,
      }),
    });
    tokens = await parseJsonResponse(response, 'Wymiana kodu OAuth');
    if (!await zakonczTokenOAuth(env, state, rezerwacja.id)) {
      throw new Error('Nie udało się zatwierdzić wykorzystania stanu OAuth.');
    }
  } catch (error) {
    await zwolnijTokenOAuth(env, state, rezerwacja.id).catch((releaseError) => {
      console.error('Nie udało się zwolnić rezerwacji OAuth:', releaseError.message);
    });
    console.error('Wymiana kodu OAuth:', error.message);
    return text('Nie udało się zakończyć autoryzacji Kick. Jeśli błąd się powtórzy, uruchom autoryzację ponownie.', 502);
  }
  if (pending.discord_id) {
    try {
      const user = await kickCurrentUser(tokens.access_token, 10_000);
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
          await repo.uzupelnijIdSubskrypcjiPoNicku({
            broadcasterId, kickUserId: user.user_id, kickUsername: username,
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
    const owner = await kickCurrentUser(tokens.access_token);
    const configuredId = String(env.KICK_BROADCASTER_ID || '').trim();
    const storedId = await env.SUBS_KV.get('config:broadcaster_id');
    if (configuredId && !/^[0-9]{1,32}$/.test(configuredId)) {
      return text('KICK_BROADCASTER_ID ma nieprawidłowy format.', 500);
    }
    if (storedId && !/^[0-9]{1,32}$/.test(storedId)) {
      return text('Zapisany ID kanału Kick jest nieprawidłowy.', 500);
    }
    if (
      (pending.expected_username && owner.username.toLowerCase() !== pending.expected_username)
      || (configuredId && owner.user_id !== configuredId)
      || (storedId && owner.user_id !== storedId)
    ) {
      return text('Autoryzowane konto Kick nie jest wcześniej skonfigurowanym kanałem. Zmiana kanału wymaga osobnej procedury.', 403);
    }
    // Nie zapisujemy tokenów ani konfiguracji, dopóki tożsamość kanału nie przejdzie kontroli.
    await saveTokens(env, tokens);
    await env.SUBS_KV.put('config:broadcaster_id', owner.user_id);
    await env.SUBS_KV.put('config:broadcaster_username', owner.username);
    const repo = repozytorium(env);
    if (repo) await repo.zapiszKanal({ broadcasterId: owner.user_id, username: owner.username });
  } catch (error) {
    console.error('Zapis autoryzacji właściciela:', error.message);
    return text('Kick autoryzował aplikację, ale zapis konfiguracji kanału się nie powiódł. Tokeny pozostają w KV; ponów próbę konfiguracji bez ponownego OAuth.', 500);
  }
  return text('Autoryzacja właściciela kanału zakończona. Tokeny pozostają w KV. Administrator może teraz zarejestrować webhooki.');
}
async function handleRegisterEvents(request, env) {
  if (zapisyZamrozone(env)) return json({ error: 'migration_write_freeze' }, 503, { 'Retry-After': '120' });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  if (!await bearerAuthorized(request, env)) return json({ error: 'unauthorized' }, 401);
  try {
    const broadcasterId = await pobierzBroadcasterId(env);
    const broadcasterNumber = Number(broadcasterId);
    if (!Number.isSafeInteger(broadcasterNumber) || broadcasterNumber <= 0) {
      return json({ error: 'invalid_broadcaster_id' }, 500);
    }
    const accessToken = await getBroadcasterAccessToken(env);
    const response = await fetch(KICK_EVENTS_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        broadcaster_user_id: broadcasterNumber,
        events: [
          { name: 'channel.subscription.new', version: 1 },
          { name: 'channel.subscription.renewal', version: 1 },
          { name: 'channel.subscription.gifts', version: 1 },
        ],
        method: 'webhook',
      }),
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch {
      return json({ error: 'invalid_kick_response' }, 502);
    }
    if (!response.ok) {
      console.error('Kick odrzucił rejestrację webhooków:', response.status, raw.slice(0, 300));
      return json({ error: 'kick_registration_failed', upstream_status: response.status }, 502);
    }
    const kontrola = walidujWynikRejestracjiWebhookow(data);
    if (!kontrola.ok) {
      console.error('Kick nie potwierdził wszystkich webhooków:', JSON.stringify(kontrola).slice(0, 500));
      return json({
        error: 'incomplete_registration',
        missing_events: kontrola.brakujace,
        rejected_events: kontrola.niepoprawne,
      }, 502);
    }
    const identyfikatory = Object.fromEntries(
      data.data.map(({ name, subscription_id }) => [name, subscription_id]),
    );
    await env.SUBS_KV.put('kick:webhook:subscription_ids', JSON.stringify(identyfikatory));
    return json({
      success: true,
      broadcaster_user_id: broadcasterId,
      registered_events: data.data.map(({ name, version, subscription_id }) => ({ name, version, subscription_id })),
    });
  } catch (error) {
    console.error('Rejestracja webhooków:', error.message);
    return json({ error: 'registration_failed' }, 502);
  }
}
async function handleWebhook(request, env) {
  if (zapisyZamrozone(env)) return text('Migration write freeze', 503, { 'Retry-After': '120' });
  if (request.method !== 'POST') return text('Method Not Allowed', 405);
  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > 256_000) return text('Payload Too Large', 413);
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > 256_000) return text('Payload Too Large', 413);
  const verification = await verifyWebhookSignature(env, request.headers, rawBody);
  if (!verification || verification.valid !== true) return text('Invalid signature or stale event', 401);

  let payload;
  try { payload = JSON.parse(rawBody); } catch { return text('Invalid JSON', 400); }
  const eventType = request.headers.get('Kick-Event-Type') || '';
  const eventVersion = request.headers.get('Kick-Event-Version') || '';
  if (!walidujTypIWersjeWebhooka(eventType, eventVersion)) {
    return text('Unsupported event type or version', 400);
  }
  const subscriptionId = request.headers.get('Kick-Event-Subscription-Id') || '';
  const zapisaneSubskrypcje = await env.SUBS_KV.get('kick:webhook:subscription_ids', 'json');
  if (!walidujIdSubskrypcjiWebhooka(subscriptionId, eventType, zapisaneSubskrypcje)) {
    console.warn('Odrzucono webhook z nieznanym ID subskrypcji:', {
      eventId: verification.id,
      eventType,
      subscriptionId: subscriptionId || null,
    });
    return text('Unknown webhook subscription', 403);
  }
  const repo = repozytorium(env);
  const broadcasterId = await pobierzBroadcasterId(env);
  const payloadBroadcasterId = String(payload?.broadcaster?.user_id ?? '');
  if (!walidujBroadcasteraWebhooka(payload, broadcasterId)) {
    console.warn('Odrzucono webhook dla innego kanału:', {
      eventId: verification.id,
      expectedBroadcasterId: broadcasterId,
      receivedBroadcasterId: payloadBroadcasterId || null,
    });
    return text('Broadcaster mismatch', 403);
  }
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
        if (
          !subscriber
          || typeof subscriber.username !== 'string'
          || !USERNAME_RE.test(subscriber.username)
          || !validExpiry
          || (subscriber.user_id != null && !/^[0-9]{1,32}$/.test(String(subscriber.user_id)))
        ) {
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
          if (
            typeof giftee?.username !== 'string'
            || !USERNAME_RE.test(giftee.username)
            || (giftee.user_id != null && !/^[0-9]{1,32}$/.test(String(giftee.user_id)))
          ) continue;
          subscriptions.push({
            kickUserId: giftee.user_id == null ? null : String(giftee.user_id),
            kickUsername: giftee.username, expiresAtMs, source: eventType,
          });
        }
        if (!subscriptions.length) throw new Error('Gift webhook contains no valid recipients');
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
    if (
      typeof subscriber?.username !== 'string'
      || !USERNAME_RE.test(subscriber.username)
      || !validExpiry
      || (subscriber.user_id != null && !/^[0-9]{1,32}$/.test(String(subscriber.user_id)))
    ) {
      return text('Invalid subscription payload', 400);
    }
    await saveSubscription(env, { username: subscriber.username, user_id: subscriber.user_id, expires_at: expiryIso, source: eventType });
  } else if (eventType === 'channel.subscription.gifts') {
    const giftees = payload?.giftees;
    if (!Array.isArray(giftees) || !giftees.length || !validExpiry) return text('Invalid gifted subscription payload', 400);
    let zapisani = 0;
    for (const giftee of giftees) {
      if (
        typeof giftee?.username !== 'string'
        || !USERNAME_RE.test(giftee.username)
        || (giftee.user_id != null && !/^[0-9]{1,32}$/.test(String(giftee.user_id)))
      ) continue;
      await saveSubscription(env, { username: giftee.username, user_id: giftee.user_id, expires_at: expiryIso, source: eventType });
      zapisani++;
    }
    if (!zapisani) return text('Invalid gifted subscription recipients', 400);
  }
  await env.SUBS_KV.put(seenKey, '1', { expirationTtl: 86400 });
  return text('OK');
}

async function saveSubscription(env, subscription) {
  const username = subscription.username.trim();
  const key = `sub:${username.toLowerCase()}`;
  const old = await env.SUBS_KV.get(key, 'json');
  const expiry = Date.parse(subscription.expires_at);
  if (!Number.isFinite(expiry)) throw new TypeError('Nieprawidłowa data wygaśnięcia subskrypcji.');
  const userId = String(subscription.user_id ?? old?.user_id ?? '');
  const record = {
    user_id: /^[0-9]{1,32}$/.test(userId) ? userId : '',
    username,
    expires_at: subscription.expires_at,
    source: subscription.source,
    updated_at: new Date().toISOString(),
  };
  // Nie pozwalamy starszemu eventowi cofnąć nowszej subskrypcji.
  if (!old || !Number.isFinite(Date.parse(old.expires_at)) || expiry >= Date.parse(old.expires_at)) {
    await env.SUBS_KV.put(key, JSON.stringify(record));
    if (record.user_id) {
      const userIdKey = `sub:user_id:${record.user_id}`;
      const oldById = await env.SUBS_KV.get(userIdKey, 'json');
      const oldByIdExpiry = Date.parse(oldById?.expires_at || '');
      if (!Number.isFinite(oldByIdExpiry) || expiry >= oldByIdExpiry) {
        await env.SUBS_KV.put(userIdKey, JSON.stringify(record));
      }
    }
  }
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const administracyjny = url.pathname === '/api/admin/migrate-kv';
  const autoryzowany = administracyjny
    ? await adminBearerAuthorized(request, env)
    : await bearerAuthorized(request, env);
  if (!autoryzowany) return json({ error: 'unauthorized' }, 401);
  if (url.pathname === '/api/check') {
    const username = (url.searchParams.get('username') || '').replace(/^@/, '').trim();
    const userId = (url.searchParams.get('user_id') || '').trim();
    if (userId && !/^[0-9]{1,32}$/.test(userId)) return json({ error: 'invalid_user_id' }, 400);
    if (!userId && !USERNAME_RE.test(username)) return json({ error: 'invalid_username' }, 400);
    if (username && !USERNAME_RE.test(username)) return json({ error: 'invalid_username' }, 400);

    const repo = repozytorium(env);
    if (repo) {
      const status = await repo.sprawdzSubskrypcje({
        broadcasterId: await pobierzBroadcasterId(env),
        kickUserId: userId || null,
        kickUsername: username || null,
      });
      return json({
        username: status.username || username || null, known: status.status !== 'unknown',
        status: status.status, subscribed: status.subscribed,
        expires_at: status.expires_at_ms ? new Date(status.expires_at_ms).toISOString() : null,
      });
    }

    let record = userId ? await env.SUBS_KV.get(`sub:user_id:${userId}`, 'json') : null;
    if (!record && username) {
      const byName = await env.SUBS_KV.get(`sub:${username.toLowerCase()}`, 'json');
      if (!userId || (byName && String(byName.user_id || '') === userId)) record = byName;
    }
    const expiry = record ? Date.parse(record.expires_at) : NaN;
    if (!record || !Number.isFinite(expiry)) {
      return json({ username: record?.username || username || null, known: false, status: 'unknown', subscribed: null, expires_at: record?.expires_at || null });
    }
    const subscribed = expiry > Date.now();
    return json({ username: record.username || username || null, known: true, status: subscribed ? 'active' : 'inactive', subscribed, expires_at: record.expires_at });
  }
  if (url.pathname === '/api/owner/start') {
    if (zapisyZamrozone(env)) return json({ error: 'migration_write_freeze' }, 503, { 'Retry-After': '120' });
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    const ownerToken = randomString(32);
    await zapiszTokenJednorazowy(env, ownerToken, 'owner-start', { created_at: Date.now() });
    return json({ url: `${url.origin}/authorize?${new URLSearchParams({ owner_token: ownerToken })}` });
  }
  if (url.pathname === '/api/link/start') {
    if (zapisyZamrozone(env)) return json({ error: 'migration_write_freeze' }, 503, { 'Retry-After': '120' });
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    let body; try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    const discordId = String(body.discord_id || '');
    if (!/^\d{17,20}$/.test(discordId)) return json({ error: 'invalid_discord_id' }, 400);
    const linkToken = randomString(32);
    await zapiszTokenJednorazowy(env, linkToken, 'link-start', { discord_id: discordId, created_at: Date.now() });
    return json({ url: `${url.origin}/authorize?${new URLSearchParams({ link_token: linkToken })}` });
  }
  if (url.pathname === '/api/link') {
    const discordId = url.searchParams.get('discord_id') || '';
    if (!/^\d{17,20}$/.test(discordId)) return json({ error: 'invalid_discord_id' }, 400);
    const repo = repozytorium(env);
    if (repo) {
      const record = await repo.pobierzPowiazanie({ broadcasterId: await pobierzBroadcasterId(env), discordUserId: discordId });
      return json({ username: record?.kick_username || null, kick_user_id: record?.kick_user_id || null, linked_at: record?.linked_at_ms ? new Date(record.linked_at_ms).toISOString() : null });
    }
    const record = await env.SUBS_KV.get(`link:discord:${discordId}`, 'json');
    return json({ username: record?.username || null, kick_user_id: record?.kick_user_id || null, linked_at: record?.linked_at || null });
  }
  if (url.pathname === '/api/admin/migrate-kv') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    const dozwoloneParametry = new Set([
      'dry_run', 'links_cursor', 'subscriptions_cursor', 'links_done', 'subscriptions_done',
    ]);
    const nieznaneParametry = [...url.searchParams.keys()].filter((parametr) => !dozwoloneParametry.has(parametr));
    if (nieznaneParametry.length > 0) return json({ error: 'invalid_query_parameter' }, 400);
    if (request.body !== null) return json({ error: 'unexpected_request_body' }, 400);
    for (const parametr of dozwoloneParametry) {
      if (parametr !== 'dry_run' && url.searchParams.getAll(parametr).length > 1) {
        return json({ error: 'duplicate_query_parameter' }, 400);
      }
    }
    const parametryDryRun = url.searchParams.getAll('dry_run');
    if (parametryDryRun.length > 1 || (parametryDryRun.length === 1 && !['true', 'false'].includes(parametryDryRun[0]))) {
      return json({ error: 'invalid_dry_run' }, 400);
    }
    const dryRun = parametryDryRun[0] !== 'false';
    const parametryPaginacji = ['links_cursor', 'subscriptions_cursor', 'links_done', 'subscriptions_done'];
    if (!dryRun && !zapisyZamrozone(env)) {
      return json({ error: 'migration_write_freeze_required' }, 409);
    }
    if (!dryRun && parametryPaginacji.some((parametr) => url.searchParams.has(parametr))) {
      return json({ error: 'pagination_only_available_for_dry_run' }, 400);
    }
    for (const parametr of ['links_done', 'subscriptions_done']) {
      const wartosc = url.searchParams.get(parametr);
      if (wartosc !== null && !['true', 'false'].includes(wartosc)) {
        return json({ error: 'invalid_pagination_flag' }, 400);
      }
    }
    for (const parametr of ['links_cursor', 'subscriptions_cursor']) {
      const wartosc = url.searchParams.get(parametr);
      if (wartosc !== null && (!wartosc || wartosc.length > 2048)) {
        return json({ error: 'invalid_pagination_cursor' }, 400);
      }
    }
    if (
      (url.searchParams.get('links_done') === 'true' && url.searchParams.has('links_cursor'))
      || (url.searchParams.get('subscriptions_done') === 'true' && url.searchParams.has('subscriptions_cursor'))
    ) return json({ error: 'conflicting_pagination_parameters' }, 400);
    const repo = repozytorium(env, true);
    if (!repo) return json({ error: 'd1_not_configured' }, 503);
    if (!env.SUBS_KV || typeof env.SUBS_KV.get !== 'function' || typeof env.SUBS_KV.list !== 'function') {
      return json({ error: 'kv_not_configured' }, 503);
    }
    const tokenDoMigracji = await pobierzTokenMigracji({
      env,
      dryRun,
      odswiezToken: (srodowisko) => getBroadcasterAccessToken(srodowisko, 10_000),
    });
    const owner = await kickCurrentUser(tokenDoMigracji, 10_000);
    const configuredId = String(env.KICK_BROADCASTER_ID || '').trim();
    const storedId = await env.SUBS_KV.get('config:broadcaster_id');
    if (
      (configuredId && configuredId !== owner.user_id)
      || (storedId && storedId !== owner.user_id)
    ) return json({ error: 'broadcaster_mismatch' }, 409);

    if (!dryRun) {
      const leaseToken = randomString(32);
      const teraz = Date.now();
      const przejeto = await repo.zapewnijKanalIPrzejmijMigracje({
        broadcasterId: owner.user_id, username: owner.username,
        leaseToken, teraz, leaseMs: 240_000,
      });
      if (!przejeto) {
        const stan = await repo.pobierzStanMigracji({ broadcasterId: owner.user_id });
        if (stan?.status === 'completed') {
          return json({ success: true, already_completed: true, broadcaster_id: owner.user_id });
        }
        return json({ error: 'migration_locked', retry_after_ms: Math.max(0, Number(stan?.lease_expires_at_ms || teraz) - teraz) }, 409);
      }

      try {
        const stan = await repo.pobierzStanMigracji({ broadcasterId: owner.user_id });
        if (!stan || stan.status !== 'running' || stan.lease_token !== leaseToken) {
          return json({ error: 'migration_state_unavailable' }, 409);
        }
        let counts;
        try {
          if (typeof stan.counts_json !== 'string') throw new Error('invalid_counts_type');
          counts = JSON.parse(stan.counts_json);
        } catch {
          throw new Error('Nieprawidłowe liczniki zapisane w stanie migracji.');
        }
        if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
          throw new Error('Liczniki migracji muszą być obiektem JSON.');
        }
        if (!['links', 'subscriptions', 'completed'].includes(stan.phase)) {
          throw new Error('Nieprawidłowa faza zapisana w stanie migracji.');
        }
        if (stan.cursor != null && (
          typeof stan.cursor !== 'string' || !stan.cursor || stan.cursor.length > 2048
        )) {
          throw new Error('Nieprawidłowy kursor zapisany w stanie migracji.');
        }
        const polaLicznikow = [
          'links_seen', 'links_valid', 'links_imported', 'links_skipped', 'links_conflicts',
          'subscriptions_seen', 'subscriptions_valid', 'subscriptions_imported', 'subscriptions_skipped',
        ];
        for (const pole of polaLicznikow) {
          const wartosc = counts[pole] ?? 0;
          if (!Number.isSafeInteger(wartosc) || wartosc < 0) {
            throw new Error(`Nieprawidłowy licznik migracji: ${pole}.`);
          }
        }
        const raport = {
          dry_run: false, broadcaster_id: owner.user_id,
          links_seen: counts.links_seen ?? 0,
          links_valid: counts.links_valid ?? 0,
          links_imported: counts.links_imported ?? 0,
          links_skipped: counts.links_skipped ?? 0,
          links_conflicts: counts.links_conflicts ?? 0,
          subscriptions_seen: counts.subscriptions_seen ?? 0,
          subscriptions_valid: counts.subscriptions_valid ?? 0,
          subscriptions_imported: counts.subscriptions_imported ?? 0,
          subscriptions_skipped: counts.subscriptions_skipped ?? 0,
          errors: [],
        };
        const dodajBlad = (typ, key, reason) => {
          if (raport.errors.length < 50) raport.errors.push({ type: typ, key, reason });
        };
        // Po zapisaniu końcowego checkpointu wznowienie ma wykonać wyłącznie finalizację.
        // Nie wolno wracać do fazy links, bo ponowne liczenie stron podwoiłoby liczniki.
        if (stan.phase === 'completed') {
          const trwaleZaimportowane = await repo.policzElementyMigracji({ broadcasterId: owner.user_id });
          const oczekiwaneLinki = raport.links_valid - raport.links_conflicts;
          if (
            oczekiwaneLinki < 0
            || trwaleZaimportowane.links !== oczekiwaneLinki
            || trwaleZaimportowane.subscriptions !== raport.subscriptions_valid
          ) {
            throw new Error('Niezgodność liczby zaimportowanych rekordów KV i trwałych markerów D1.');
          }
          raport.links_imported = trwaleZaimportowane.links;
          raport.subscriptions_imported = trwaleZaimportowane.subscriptions;
          const zakonczono = await repo.zakonczMigracje({
            broadcasterId: owner.user_id, leaseToken, teraz: Date.now(),
          });
          if (!zakonczono) return json({ error: 'migration_lease_lost' }, 409);
          return json({
            success: true, complete: true, phase: 'completed',
            has_more: false, processed_this_request: 0, ...raport,
          });
        }

        const phase = stan.phase;
        const prefix = phase === 'links' ? 'link:discord:' : 'sub:';
        // 16 rekordów × (odczyt KV + jeden D1 batch) + operacje stałe
        // zostawiają margines do limitu 50 subrequests na Worker invocation w planie Free.
        const pageLimit = 16;
        const page = await env.SUBS_KV.list({
          prefix, cursor: stan.cursor || undefined, limit: pageLimit,
        });
        if (
          !page || !Array.isArray(page.keys) || page.keys.length > pageLimit
          || typeof page.list_complete !== 'boolean'
          || (!page.list_complete && (
            typeof page.cursor !== 'string' || !page.cursor || page.cursor.length > 2048
          ))
        ) {
          throw new Error('KV zwróciło niekompletną lub nieprawidłową stronę migracji.');
        }

        if (phase === 'links') {
          for (const key of page.keys) {
            raport.links_seen++;
            const record = await env.SUBS_KV.get(key.name, 'json');
            const discordIdZKlucza = key.name.slice('link:discord:'.length);
            const discordId = String(record?.discord_id || '');
            const kickId = String(record?.kick_user_id || '');
            const username = record?.username;
            if (
              !/^\d{17,20}$/.test(discordIdZKlucza)
              || discordId !== discordIdZKlucza
              || !/^\d{17,20}$/.test(discordId)
              || !/^[0-9]{1,32}$/.test(kickId)
              || typeof username !== 'string' || !USERNAME_RE.test(username)
            ) {
              raport.links_skipped++;
              dodajBlad('link', key.name, 'invalid_record');
              continue;
            }
            raport.links_valid++;
            try {
              const nowy = await repo.importujPowiazanieMigracja({
                broadcasterId: owner.user_id, sourceKey: key.name,
                discordUserId: discordId, kickUserId: kickId, kickUsername: username,
              });
              if (nowy) {
                raport.links_imported++;
              } else {
                raport.links_skipped++;
                raport.links_conflicts++;
                dodajBlad('link', key.name, 'unique_conflict');
              }
            } catch (error) {
              if (/UNIQUE|constraint/i.test(String(error.message))) {
                raport.links_skipped++;
                raport.links_conflicts++;
                dodajBlad('link', key.name, 'unique_conflict');
              } else {
                throw error;
              }
            }
          }
        } else {
          for (const key of page.keys) {
            if (key.name.startsWith('sub:user_id:')) continue;
            raport.subscriptions_seen++;
            const record = await env.SUBS_KV.get(key.name, 'json');
            const expiry = Date.parse(record?.expires_at || '');
            const username = record?.username;
            const expectedKey = typeof username === 'string' ? `sub:${username.toLowerCase()}` : '';
            const kickId = record?.user_id == null || record.user_id === '' ? null : String(record.user_id);
            if (
              typeof username !== 'string' || !USERNAME_RE.test(username)
              || key.name !== expectedKey
              || !Number.isSafeInteger(expiry) || expiry <= 0
              || (kickId !== null && !/^[0-9]{1,32}$/.test(kickId))
            ) {
              raport.subscriptions_skipped++;
              dodajBlad('subscription', key.name, 'invalid_record');
              continue;
            }
            raport.subscriptions_valid++;
            try {
              const nowa = await repo.importujSubskrypcjeMigracja({
                broadcasterId: owner.user_id, sourceKey: key.name,
                kickUserId: kickId, kickUsername: username, expiresAtMs: expiry,
                source: ['channel.subscription.new', 'channel.subscription.renewal', 'channel.subscription.gifts', 'gift', 'new', 'renewal', 'admin'].includes(record.source) ? record.source : 'admin',
              });
              if (nowa) raport.subscriptions_imported++;
            } catch (error) {
              throw error;
            }
          }
        }

        let nextPhase = phase;
        let nextCursor = page.list_complete ? null : page.cursor;
        if (phase === 'links' && page.list_complete) {
          nextPhase = 'subscriptions';
          nextCursor = null;
        }
        const zakonczone = phase === 'subscriptions' && page.list_complete;
        if (zakonczone) {
          const trwaleZaimportowane = await repo.policzElementyMigracji({ broadcasterId: owner.user_id });
          const oczekiwaneLinki = raport.links_valid - raport.links_conflicts;
          if (
            oczekiwaneLinki < 0
            || trwaleZaimportowane.links !== oczekiwaneLinki
            || trwaleZaimportowane.subscriptions !== raport.subscriptions_valid
          ) {
            throw new Error('Niezgodność liczby zaimportowanych rekordów KV i trwałych markerów D1.');
          }
          raport.links_imported = trwaleZaimportowane.links;
          raport.subscriptions_imported = trwaleZaimportowane.subscriptions;
        }
        const zapisano = await repo.zapiszPostepMigracji({
          broadcasterId: owner.user_id, leaseToken,
          phase: zakonczone ? 'completed' : nextPhase,
          cursor: nextCursor,
          counts: {
            links_seen: raport.links_seen, links_valid: raport.links_valid,
            links_imported: raport.links_imported, links_skipped: raport.links_skipped,
            links_conflicts: raport.links_conflicts,
            subscriptions_seen: raport.subscriptions_seen,
            subscriptions_valid: raport.subscriptions_valid,
            subscriptions_imported: raport.subscriptions_imported,
            subscriptions_skipped: raport.subscriptions_skipped,
          },
          teraz: Date.now(), leaseMs: 240_000,
        });
        if (!zapisano) return json({ error: 'migration_lease_lost' }, 409);
        if (zakonczone) {
          const zakonczono = await repo.zakonczMigracje({
            broadcasterId: owner.user_id, leaseToken, teraz: Date.now(),
          });
          if (!zakonczono) return json({ error: 'migration_lease_lost' }, 409);
        }
        return json({
          success: true, complete: zakonczone,
          phase: zakonczone ? 'completed' : nextPhase,
          has_more: !zakonczone,
          processed_this_request: page.keys.length,
          ...raport,
        });
      } finally {
        await repo.zwolnijMigracje({
          broadcasterId: owner.user_id, leaseToken, teraz: Date.now(),
        }).catch((error) => console.error('Zwolnienie blokady migracji:', error.message));
      }
    }

    const raport = {
      dry_run: dryRun, broadcaster_id: owner.user_id,
      links_seen: 0, links_valid: 0, links_imported: 0, links_skipped: 0,
      subscriptions_seen: 0, subscriptions_valid: 0, subscriptions_imported: 0,
      errors: [],
    };
    const dodajBlad = (typ, key, reason) => {
      if (raport.errors.length < 50) raport.errors.push({ type: typ, key, reason });
    };
    const discordIds = new Set();
    const kickIds = new Set();
    const dryRunPageLimit = 12;
    let linksComplete = url.searchParams.get('links_done') === 'true';
    let subscriptionsComplete = url.searchParams.get('subscriptions_done') === 'true';
    let linksCursor = url.searchParams.get('links_cursor') || null;
    let subscriptionsCursor = url.searchParams.get('subscriptions_cursor') || null;

    if (!linksComplete) {
      const page = await env.SUBS_KV.list({
        prefix: 'link:discord:', cursor: linksCursor || undefined, limit: dryRunPageLimit,
      });
      if (
        !page || !Array.isArray(page.keys) || page.keys.length > dryRunPageLimit
        || typeof page.list_complete !== 'boolean'
        || (!page.list_complete && (
          typeof page.cursor !== 'string' || !page.cursor || page.cursor.length > 2048
        ))
      ) throw new Error('KV zwróciło niekompletną lub nieprawidłową stronę linków.');
      for (const key of page.keys) {
        raport.links_seen++;
        const record = await env.SUBS_KV.get(key.name, 'json');
        const discordIdZKlucza = key.name.slice('link:discord:'.length);
        const discordId = String(record?.discord_id || '');
        const kickId = String(record?.kick_user_id || '');
        const username = record?.username;
        if (
          !/^\d{17,20}$/.test(discordIdZKlucza)
          || discordId !== discordIdZKlucza
          || !/^\d{17,20}$/.test(discordId)
          || !/^[0-9]{1,32}$/.test(kickId)
          || typeof username !== 'string' || !USERNAME_RE.test(username)
        ) {
          raport.links_skipped++;
          dodajBlad('link', key.name, 'invalid_record');
          continue;
        }
        if (discordIds.has(discordId) || kickIds.has(kickId)) {
          raport.links_skipped++;
          dodajBlad('link', key.name, 'duplicate_discord_or_kick_id');
          continue;
        }
        discordIds.add(discordId);
        kickIds.add(kickId);
        raport.links_valid++;
      }
      linksComplete = page.list_complete;
      linksCursor = page.list_complete ? null : page.cursor;
    }

    if (!subscriptionsComplete) {
      const page = await env.SUBS_KV.list({
        prefix: 'sub:', cursor: subscriptionsCursor || undefined, limit: dryRunPageLimit,
      });
      if (
        !page || !Array.isArray(page.keys) || page.keys.length > dryRunPageLimit
        || typeof page.list_complete !== 'boolean'
        || (!page.list_complete && (
          typeof page.cursor !== 'string' || !page.cursor || page.cursor.length > 2048
        ))
      ) throw new Error('KV zwróciło niekompletną lub nieprawidłową stronę subskrypcji.');
      for (const key of page.keys) {
        if (key.name.startsWith('sub:user_id:')) continue;
        raport.subscriptions_seen++;
        const record = await env.SUBS_KV.get(key.name, 'json');
        const expiry = Date.parse(record?.expires_at || '');
        const username = record?.username;
        const expectedKey = typeof username === 'string' ? `sub:${username.toLowerCase()}` : '';
        const kickId = record?.user_id == null || record.user_id === '' ? null : String(record.user_id);
        if (
          typeof username !== 'string' || !USERNAME_RE.test(username)
          || key.name !== expectedKey
          || !Number.isSafeInteger(expiry) || expiry <= 0
          || (kickId !== null && !/^[0-9]{1,32}$/.test(kickId))
        ) {
          dodajBlad('subscription', key.name, 'invalid_record');
          continue;
        }
        raport.subscriptions_valid++;
      }
      subscriptionsComplete = page.list_complete;
      subscriptionsCursor = page.list_complete ? null : page.cursor;
    }
    return json({
      ...raport,
      links_complete: linksComplete,
      subscriptions_complete: subscriptionsComplete,
      has_more: !linksComplete || !subscriptionsComplete,
      links_cursor: linksCursor,
      subscriptions_cursor: subscriptionsCursor,
      counts_scope: 'current_page',
      duplicate_check_scope: 'current_page',
    });
  }
  if (url.pathname === '/api/links') {
    const repo = repozytorium(env);
    if (repo) {
      const broadcasterId = await pobierzBroadcasterId(env);
      const links = [];
      let offset = 0;
      while (true) {
        const page = await repo.pobierzPowiazania({ broadcasterId, limit: 1000, offset });
        links.push(...page.map((record) => ({ discord_id: record.discord_user_id, username: record.kick_username, kick_user_id: record.kick_user_id })));
        if (page.length < 1000) break;
        offset += page.length;
      }
      return json({ links });
    }
    const links = []; let cursor;
    do {
      const page = await env.SUBS_KV.list({ prefix: 'link:discord:', cursor, limit: 1000 });
      for (const key of page.keys) {
        const record = await env.SUBS_KV.get(key.name, 'json');
        if (record?.discord_id && record?.username) links.push({ discord_id: record.discord_id, username: record.username, kick_user_id: record.kick_user_id || null });
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return json({ links });
  }
  return json({ error: 'not_found' }, 404);
}
function previewPage() {
  return `<!doctype html>
<html lang="pl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>KickSubChecker — podgląd</title>
  <style>
    :root{color-scheme:dark;font-family:system-ui,sans-serif;background:#101114;color:#f3f4f6}
    body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;box-sizing:border-box}
    main{width:min(560px,100%);padding:32px;border:1px solid #34363d;border-radius:18px;background:#191b20}
    h1{margin:0 0 12px;font-size:1.7rem}p{line-height:1.6;color:#c4c7cf}
    a{color:#a5b4fc}small{color:#8b909b}
  </style>
</head>
<body><main><h1>KickSubChecker</h1><p>Podgląd integracji subskrypcji Kick z Discordem.</p><p>Autoryzacja konta widza odbywa się wyłącznie przez komendę <strong>/polacz-konto</strong> na skonfigurowanym serwerze Discord.</p><small>Ta strona nie wyświetla ani nie modyfikuje danych subskrybentów.</small></main></body>
</html>`;
}

async function handleLjayLive(request, env) {
  if (request.method !== 'GET') return text('Method Not Allowed', 405, { Allow: 'GET' });
  const verifier = randomString(64);
  const challenge = base64UrlEncode(await sha256(verifier));
  const state = randomString(24);
  await zapiszTokenJednorazowy(env, state, 'oauth-state', {
    verifier, discord_id: null, owner: true, expected_username: 'ljaylive', created_at: Date.now(),
  });
  const params = new URLSearchParams({
    response_type: 'code', client_id: env.KICK_CLIENT_ID, redirect_uri: env.REDIRECT_URI,
    scope: 'user:read channel:read events:subscribe', code_challenge: challenge,
    code_challenge_method: 'S256', state,
  });
  return Response.redirect(`${KICK_AUTHORIZE_URL}?${params}`, 302);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/ljay-live' || url.pathname === '/ljay-live/start') return handleLjayLive(request, env);
      if (url.pathname === '/preview') return new Response(previewPage(), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" } });
      if (url.pathname === '/authorize') return handleAuthorize(request, env);
      if (url.pathname === '/callback') return handleCallback(request, env);
      if (url.pathname === '/webhook') return handleWebhook(request, env);
      if (url.pathname === '/register-events') return handleRegisterEvents(request, env);
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env);
      if (url.pathname === '/') return text('Kick Sub Checker Worker działa.');
      return text('Not Found', 404);
    } catch (error) {
      console.error('Worker error:', error.message);
      return url.pathname.startsWith('/api/') ? json({ error: 'internal_error' }, 500) : text('Wystąpił wewnętrzny błąd serwera.', 500);
    }
  },

  async scheduled(_event, env, ctx) {
    const repo = repozytorium(env);
    if (!repo) return;
    ctx.waitUntil(
      repo.oczyscWebhooki({ retentionBeforeMs: Date.now() - 30 * 24 * 60 * 60 * 1000 })
        .then((usuniete) => console.log(`Retencja webhooków: usunięto ${usuniete} starych rekordów.`))
        .catch((error) => console.error('Czyszczenie retencji webhooków nie powiodło się:', error.message)),
    );
  },
};
