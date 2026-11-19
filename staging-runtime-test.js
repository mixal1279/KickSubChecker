import worker from "./index.js";
export { OAuthTokenStore } from "./oauth-token-store.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  },
});

async function adminAutoryzowany(request, env) {
  const sekret = env.ADMIN_API_SECRET;
  if (typeof sekret !== "string" || !sekret || sekret === env.BOT_API_SECRET) return false;

  const oczekiwany = new TextEncoder().encode(`Bearer ${sekret}`);
  const otrzymany = new TextEncoder().encode(request.headers.get("Authorization") || "");
  if (oczekiwany.length !== otrzymany.length) return false;

  let roznica = 0;
  for (let i = 0; i < oczekiwany.length; i++) roznica |= oczekiwany[i] ^ otrzymany[i];
  return roznica === 0;
}

function wymagajMagazynu(env, nazwa) {
  if (!env.OAUTH_TOKENS || typeof env.OAUTH_TOKENS.getByName !== "function") {
    throw new Error("Brak stagingowego bindingu Durable Objects.");
  }
  return env.OAUTH_TOKENS.getByName(nazwa);
}

async function wykonajTestyDO(env) {
  const znacznik = crypto.randomUUID().replaceAll("-", "");
  const teraz = Date.now();

  const tokenStore = wymagajMagazynu(env, `staging-token-${znacznik}`);
  const token = `staging_${znacznik}`;
  await tokenStore.zapisz(token, "oauth-state", { probe: znacznik }, teraz + 60_000);
  const zuzyty = await tokenStore.zuzyj(token, "oauth-state");
  if (zuzyty?.probe !== znacznik || await tokenStore.zuzyj(token, "oauth-state") !== null) {
    throw new Error("Test jednorazowego tokena nie powiódł się.");
  }

  const lockStore = wymagajMagazynu(env, `staging-lock-${znacznik}`);
  const blokady = await Promise.all(
    Array.from({ length: 16 }, () => lockStore.zarezerwujBlokade("staging-smoke", 30_000)),
  );
  const wlasciciele = blokady.filter(Boolean);
  if (wlasciciele.length !== 1) throw new Error("Test wyłączności lease nie powiódł się.");
  await lockStore.zwolnijBlokade("staging-smoke", wlasciciele[0]);

  const refreshStore = wymagajMagazynu(env, `staging-refresh-${znacznik}`);
  const obecne = {
    access_token: "staging-access-before",
    refresh_token: "staging-refresh-before",
    expires_at: teraz + 120_000,
  };
  await refreshStore.zainicjujTokeny(obecne);
  const lease = await refreshStore.zarezerwujBlokade("broadcaster", 30_000);
  if (!lease) throw new Error("Nie udało się uzyskać lease rotacji.");
  const kandydaci = Array.from({ length: 16 }, (_, i) => ({
    access_token: `staging-access-${i}`,
    refresh_token: `staging-refresh-${i}`,
    expires_at: Date.now() + 180_000,
  }));
  const wyniki = await Promise.all(kandydaci.map((dane) =>
    refreshStore.zapiszOdswiezoneTokeny(dane, lease, obecne.refresh_token)));
  const zapisane = await refreshStore.pobierzTokeny();
  if (wyniki.filter(Boolean).length !== 1 || !kandydaci.some((dane) =>
    dane.refresh_token === zapisane?.refresh_token && dane.access_token === zapisane?.access_token)) {
    throw new Error("Test równoległego CAS refresh tokena nie powiódł się.");
  }
  await refreshStore.zwolnijBlokade("broadcaster", lease);

  const expiryStore = wymagajMagazynu(env, `staging-expiry-${znacznik}`);
  await expiryStore.zainicjujTokeny(obecne);
  const staryLease = await expiryStore.zarezerwujBlokade("broadcaster", 1_000);
  if (!staryLease) throw new Error("Nie udało się uzyskać testowego lease.");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const nowyLease = await expiryStore.zarezerwujBlokade("broadcaster", 30_000);
  if (!nowyLease || nowyLease === staryLease) throw new Error("Nie udało się przejąć wygasłego lease.");
  const staryZapis = await expiryStore.zapiszOdswiezoneTokeny(
    { access_token: "stale", refresh_token: "stale", expires_at: Date.now() + 60_000 },
    staryLease,
    obecne.refresh_token,
  );
  if (staryZapis !== false || (await expiryStore.pobierzTokeny())?.refresh_token !== obecne.refresh_token) {
    throw new Error("Stary właściciel lease mógł zapisać token.");
  }
  await expiryStore.zwolnijBlokade("broadcaster", nowyLease);

  return {
    ok: true,
    checks: {
      sqlite_rpc: true,
      one_time_token: true,
      concurrent_lock_exclusivity: true,
      concurrent_refresh_cas: true,
      expired_lease_fencing: true,
    },
  };
}

async function odczytajBodyZLimitem(request, limit) {
  const naglowek = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(naglowek) && naglowek > limit) return null;
  if (!request.body) return "";

  const czytnik = request.body.getReader();
  const fragmenty = [];
  let rozmiar = 0;
  try {
    while (true) {
      const { done, value } = await czytnik.read();
      if (done) break;
      rozmiar += value.byteLength;
      if (rozmiar > limit) {
        await czytnik.cancel();
        return null;
      }
      fragmenty.push(value);
    }
  } finally {
    czytnik.releaseLock();
  }

  const dane = new Uint8Array(rozmiar);
  let offset = 0;
  for (const fragment of fragmenty) {
    dane.set(fragment, offset);
    offset += fragment.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(dane);
}

async function obsluzTestStagingDO(request, env) {
  if (env.STAGING_DO_TESTS !== "true") return json({ error: "not_found" }, 404);
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!await adminAutoryzowany(request, env)) return json({ error: "unauthorized" }, 401);

  let body;
  try {
    const raw = await odczytajBodyZLimitem(request, 1_024);
    if (raw === null) return json({ error: "payload_too_large" }, 413);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "invalid_payload" }, 400);
  }
  const faza = body.phase;
  const testId = body.test_id;
  if (faza === "exercise") {
    try {
      return json(await wykonajTestyDO(env));
    } catch (error) {
      console.error("Staging DO smoke test failed:", error?.name || "Error");
      return json({ error: "staging_do_test_failed" }, 500);
    }
  }
  if (!["write", "read"].includes(faza) || typeof testId !== "string" || !/^[a-f0-9]{32}$/.test(testId)) {
    return json({ error: "invalid_test_request" }, 400);
  }

  try {
    const store = wymagajMagazynu(env, `staging-persist-${testId.slice(0, 8)}`);
    const token = `staging_${testId}`;
    if (faza === "write") {
      await store.zapisz(token, "oauth-state", { test_id: testId }, Date.now() + 10 * 60_000);
      return json({ ok: true, phase: "write", test_id: testId });
    }
    const dane = await store.zuzyj(token, "oauth-state");
    if (dane?.test_id !== testId) return json({ ok: false, error: "persistence_check_failed" }, 409);
    return json({ ok: true, phase: "read", persisted: true });
  } catch (error) {
    console.error("Staging DO persistence test failed:", error?.name || "Error");
    return json({ error: "staging_do_test_failed" }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/__staging/do-smoke-test") {
      return obsluzTestStagingDO(request, env);
    }
    return worker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    if (typeof worker.scheduled === "function") {
      return worker.scheduled(event, env, ctx);
    }
  },
};
