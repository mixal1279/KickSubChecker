import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { OAuthTokenStore } from '../oauth-token-store.js';

function utworzMagazyn() {
  const dane = new Map();
  const blokady = new Map();
  let tokenyWlasciciela = null;
  let tabelaTokenowUtworzona = false;
  let alarm = null;
  const sql = {
    exec(tekst, ...args) {
      const q = tekst.replace(/\\s+/g, ' ').trim().toUpperCase();
      if (q.startsWith('CREATE TABLE') || q.startsWith('CREATE INDEX')) {
        if (q.includes('OAUTH_CREDENTIALS')) tabelaTokenowUtworzona = true;
        return { toArray: () => [] };
      }
      if (q.startsWith('SELECT ACCESS_TOKEN, REFRESH_TOKEN, EXPIRES_AT FROM OAUTH_CREDENTIALS')) {
        return { toArray: () => tokenyWlasciciela ? [{ ...tokenyWlasciciela }] : [] };
      }
      if (q.startsWith('INSERT INTO OAUTH_CREDENTIALS (ID, ACCESS_TOKEN, REFRESH_TOKEN, EXPIRES_AT) VALUES (1, ?, ?, ?) ON CONFLICT(ID) DO NOTHING')) {
        if (!tokenyWlasciciela) tokenyWlasciciela = { access_token: args[0], refresh_token: args[1], expires_at: args[2] };
        return { toArray: () => [] };
      }
      if (q.startsWith('INSERT INTO OAUTH_CREDENTIALS (ID, ACCESS_TOKEN, REFRESH_TOKEN, EXPIRES_AT) VALUES (1, ?, ?, ?) ON CONFLICT(ID) DO UPDATE SET')) {
        tokenyWlasciciela = { access_token: args[0], refresh_token: args[1], expires_at: args[2] };
        return { toArray: () => [] };
      }
      if (q.startsWith('SELECT RESERVATION_ID FROM OAUTH_LOCKS')) {
        const [nazwa, id, teraz] = args;
        const wpis = blokady.get(nazwa);
        return { toArray: () => wpis && wpis.reservation_id === id && wpis.lease_until > teraz
          ? [{ reservation_id: id }] : [] };
      }
      if (q.startsWith('UPDATE OAUTH_CREDENTIALS')) {
        const [access, refresh, expires, poprzedni] = args;
        if (!tokenyWlasciciela || tokenyWlasciciela.refresh_token !== poprzedni) return { toArray: () => [] };
        tokenyWlasciciela = { access_token: access, refresh_token: refresh, expires_at: expires };
        return { toArray: () => [{ id: 1 }] };
      }
      if (q.startsWith('INSERT INTO OAUTH_LOCKS')) {
        const [nazwa, id, leaseDo, teraz] = args;
        const obecna = blokady.get(nazwa);
        if (obecna && obecna.lease_until > teraz) return { toArray: () => [] };
        blokady.set(nazwa, { reservation_id: id, lease_until: leaseDo });
        return { toArray: () => [{ lock_name: nazwa }] };
      }
      if (q.startsWith('DELETE FROM OAUTH_LOCKS')) {
        const [nazwa, id] = args;
        const obecna = blokady.get(nazwa);
        if (!obecna || obecna.reservation_id !== id) return { toArray: () => [] };
        blokady.delete(nazwa);
        return { toArray: () => [{ lock_name: nazwa }] };
      }
      if (q.startsWith('INSERT INTO OAUTH_TOKENS')) {
        const [token, typ, json, wygasa_at] = args;
        if (dane.has(token)) throw new Error('UNIQUE constraint failed');
        dane.set(token, { typ, dane: json, wygasa_at, rezerwacja_id: null, rezerwacja_do: null });
        return { toArray: () => [] };
      }
      if (q.startsWith('SELECT TYP, DANE, WYGASA_AT, REZERWACJA_DO')) {
        const wpis = dane.get(args[0]);
        return { toArray: () => wpis ? [{ typ: wpis.typ, dane: wpis.dane, wygasa_at: wpis.wygasa_at, rezerwacja_do: wpis.rezerwacja_do }] : [] };
      }
      if (q.startsWith('DELETE FROM OAUTH_TOKENS WHERE TOKEN = ? AND TYP = ? AND REZERWACJA_ID = ?')) {
        const [token, typ, id, teraz] = args;
        const wpis = dane.get(token);
        if (!wpis || wpis.typ !== typ || wpis.rezerwacja_id !== id || wpis.rezerwacja_do <= teraz) return { toArray: () => [] };
        dane.delete(token);
        return { toArray: () => [{ token }] };
      }
      if (q.startsWith('DELETE FROM OAUTH_TOKENS WHERE TOKEN = ?')) {
        dane.delete(args[0]);
        return { toArray: () => [] };
      }
      if (q.startsWith('DELETE FROM OAUTH_TOKENS WHERE WYGASA_AT <= ?')) {
        for (const [token, wpis] of dane) if (wpis.wygasa_at <= args[0]) dane.delete(token);
        return { toArray: () => [] };
      }
      if (q.startsWith('UPDATE OAUTH_TOKENS SET REZERWACJA_ID = ?, REZERWACJA_DO = ?')) {
        const [id, doKiedy, token] = args;
        const wpis = dane.get(token);
        if (wpis) { wpis.rezerwacja_id = id; wpis.rezerwacja_do = doKiedy; }
        return { toArray: () => [] };
      }
      if (q.startsWith('UPDATE OAUTH_TOKENS SET REZERWACJA_ID = NULL')) {
        const [token, typ, id] = args;
        const wpis = dane.get(token);
        if (!wpis || wpis.typ !== typ || wpis.rezerwacja_id !== id) return { toArray: () => [] };
        wpis.rezerwacja_id = null;
        wpis.rezerwacja_do = null;
        return { toArray: () => [{ token }] };
      }
      if (q.startsWith('SELECT MIN(WYGASA_AT)')) {
        const wartosci = [...dane.values()].map((x) => x.wygasa_at);
        return { toArray: () => [{ najblizsze: wartosci.length ? Math.min(...wartosci) : null }] };
      }
      throw new Error('Nieobsługiwane SQL w teście: ' + tekst);
    },
  };
  const ctx = {
    storage: {
      sql,
      transactionSync(fn) {
        const kopia = structuredClone([...dane.entries()]);
        const kopiaBlokad = structuredClone([...blokady.entries()]);
        const kopiaTokenow = structuredClone(tokenyWlasciciela);
        try { return fn(); } catch (error) {
          dane.clear();
          for (const [klucz, wartosc] of kopia) dane.set(klucz, wartosc);
          blokady.clear();
          for (const [klucz, wartosc] of kopiaBlokad) blokady.set(klucz, wartosc);
          tokenyWlasciciela = kopiaTokenow;
          throw error;
        }
      },
      async setAlarm(czas) { alarm = czas; },
      async getAlarm() { return alarm; },
    },
  };
  const magazyn = new OAuthTokenStore(ctx, {});
  return { magazyn, dane, pobierzAlarm: () => alarm, czyTabelaTokenow: () => tabelaTokenowUtworzona };
}

const token = 'AbCdEfGhIjKlMnOpQrStUvWx';

test('konstruktor tworzy tabelę trwałych tokenów właściciela', () => {
  const { czyTabelaTokenow } = utworzMagazyn();
  assert.equal(czyTabelaTokenow(), true);
});

test('token można zużyć dokładnie jeden raz', async () => {
  const { magazyn } = utworzMagazyn();
  const wartosc = { verifier: 'sekret-pkce', discord_id: '12345678901234567' };
  await magazyn.zapisz(token, 'oauth-state', wartosc, Date.now() + 60_000);
  const wyniki = await Promise.all([
    magazyn.zuzyj(token, 'oauth-state'),
    magazyn.zuzyj(token, 'oauth-state'),
  ]);
  assert.equal(wyniki.filter(Boolean).length, 1);
  assert.deepEqual(wyniki.find(Boolean), wartosc);
});

test('token wygasły jest usuwany i nie może być użyty', async () => {
  const { magazyn } = utworzMagazyn();
  await magazyn.zapisz(token, 'owner-start', { created_at: 1 }, Date.now() + 20);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await magazyn.zuzyj(token, 'owner-start'), null);
  assert.equal(await magazyn.zuzyj(token, 'owner-start'), null);
});

test('token o innym typie jest kasowany bez ujawnienia danych', async () => {
  const { magazyn } = utworzMagazyn();
  await magazyn.zapisz(token, 'link-start', { discord_id: '12345678901234567' }, Date.now() + 60_000);
  assert.equal(await magazyn.zuzyj(token, 'oauth-state'), null);
  assert.equal(await magazyn.zuzyj(token, 'link-start'), null);
});

test('nie pozwala nadpisać istniejącego tokena', async () => {
  const { magazyn } = utworzMagazyn();
  await magazyn.zapisz(token, 'oauth-state', { verifier: 'pierwszy' }, Date.now() + 60_000);
  await assert.rejects(
    magazyn.zapisz(token, 'oauth-state', { verifier: 'drugi' }, Date.now() + 60_000),
    /UNIQUE/,
  );
  assert.deepEqual(await magazyn.zuzyj(token, 'oauth-state'), { verifier: 'pierwszy' });
});

test('odrzuca nieprawidłowe dane wejściowe przed zapisem', async () => {
  const { magazyn } = utworzMagazyn();
  await assert.rejects(magazyn.zapisz('krótki', 'oauth-state', {}, Date.now() + 60_000), /token/);
  await assert.rejects(magazyn.zapisz(token, 'nieznany', {}, Date.now() + 60_000), /typ tokena/);
  await assert.rejects(magazyn.zapisz(token, 'oauth-state', {}, Date.now() - 1), /wygaśnięcia/);
});

test('równoległe callbacki dostają tylko jedną aktywną rezerwację', async () => {
  const { magazyn } = utworzMagazyn();
  await magazyn.zapisz(token, 'oauth-state', { verifier: 'pkce' }, Date.now() + 60_000);
  const rezerwacje = await Promise.all([
    magazyn.zarezerwuj(token, 'oauth-state'),
    magazyn.zarezerwuj(token, 'oauth-state'),
  ]);
  assert.equal(rezerwacje.filter(Boolean).length, 1);
  assert.equal(await magazyn.zarezerwuj(token, 'oauth-state'), null);
});

test('nieudana wymiana kodu zwalnia rezerwację do ponowienia', async () => {
  const { magazyn } = utworzMagazyn();
  await magazyn.zapisz(token, 'oauth-state', { verifier: 'pkce' }, Date.now() + 60_000);
  const pierwsza = await magazyn.zarezerwuj(token, 'oauth-state');
  assert.ok(pierwsza);
  assert.equal(await magazyn.zwolnij(token, 'oauth-state', pierwsza.id), true);
  const druga = await magazyn.zarezerwuj(token, 'oauth-state');
  assert.ok(druga);
  assert.notEqual(druga.id, pierwsza.id);
  assert.deepEqual(druga.dane, { verifier: 'pkce' });
  assert.equal(await magazyn.zakoncz(token, 'oauth-state', druga.id), true);
  assert.equal(await magazyn.zarezerwuj(token, 'oauth-state'), null);
});

test('wygasła rezerwacja może zostać przejęta po upływie lease', async () => {
  const { magazyn } = utworzMagazyn();
  const zegar = Date.now;
  let teraz = zegar();
  Date.now = () => teraz;
  try {
    await magazyn.zapisz(token, 'oauth-state', { verifier: 'pkce' }, teraz + 100_000);
    const pierwsza = await magazyn.zarezerwuj(token, 'oauth-state', 5_000);
    assert.ok(pierwsza);
    teraz += 6_001;
    const druga = await magazyn.zarezerwuj(token, 'oauth-state', 5_000);
    assert.ok(druga);
    assert.notEqual(druga.id, pierwsza.id);
    assert.equal(await magazyn.zakoncz(token, 'oauth-state', pierwsza.id), false);
  } finally {
    Date.now = zegar;
  }
});

test('blokada odświeżania dopuszcza tylko jednego właściciela', async () => {
  const { magazyn } = utworzMagazyn();
  const [pierwsza, druga] = await Promise.all([
    magazyn.zarezerwujBlokade('broadcaster', 20_000),
    magazyn.zarezerwujBlokade('broadcaster', 20_000),
  ]);
  assert.equal([pierwsza, druga].filter(Boolean).length, 1);
  const wlasciciel = pierwsza || druga;
  assert.equal(await magazyn.zwolnijBlokade('broadcaster', 'obcy-token'), false);
  assert.equal(await magazyn.zwolnijBlokade('broadcaster', wlasciciel), true);
  assert.ok(await magazyn.zarezerwujBlokade('broadcaster', 20_000));
});

test('wygasła blokada odświeżania może zostać bezpiecznie przejęta', async () => {
  const { magazyn } = utworzMagazyn();
  const zegar = Date.now;
  let teraz = zegar();
  Date.now = () => teraz;
  try {
    const pierwsza = await magazyn.zarezerwujBlokade('broadcaster', 5_000);
    assert.ok(pierwsza);
    teraz += 5_001;
    const druga = await magazyn.zarezerwujBlokade('broadcaster', 5_000);
    assert.ok(druga);
    assert.notEqual(druga, pierwsza);
    assert.equal(await magazyn.zwolnijBlokade('broadcaster', pierwsza), false);
    assert.equal(await magazyn.zwolnijBlokade('broadcaster', druga), true);
  } finally {
    Date.now = zegar;
  }
});



test('import tokenów legacy jest atomowy i nie nadpisuje nowszych danych', async () => {
  const { magazyn } = utworzMagazyn();
  const pierwsze = {
    access_token: 'access-v1', refresh_token: 'refresh-v1', expires_at: Date.now() + 60_000,
  };
  const stare = {
    access_token: 'stale-access', refresh_token: 'stale-refresh', expires_at: Date.now() + 30_000,
  };
  assert.deepEqual(await magazyn.zainicjujTokeny(pierwsze), pierwsze);
  assert.deepEqual(await magazyn.zainicjujTokeny(stare), pierwsze);
  assert.deepEqual(await magazyn.pobierzTokeny(), pierwsze);
});

test('rotacja tokena wymaga aktywnej blokady i zgodnego poprzedniego refresh tokena', async () => {
  const { magazyn } = utworzMagazyn();
  const pierwsze = {
    access_token: 'access-v1', refresh_token: 'refresh-v1', expires_at: Date.now() + 60_000,
  };
  await magazyn.zainicjujTokeny(pierwsze);
  const lease = await magazyn.zarezerwujBlokade('broadcaster', 20_000);
  assert.ok(lease);
  const nowe = {
    access_token: 'access-v2', refresh_token: 'refresh-v2', expires_at: Date.now() + 120_000,
  };
  assert.equal(await magazyn.zapiszOdswiezoneTokeny(nowe, 'obcy-lease', 'refresh-v1'), false);
  assert.equal(await magazyn.zapiszOdswiezoneTokeny(nowe, lease, 'stary-refresh'), false);
  assert.equal(await magazyn.zapiszOdswiezoneTokeny(nowe, lease, 'refresh-v1'), true);
  assert.deepEqual(await magazyn.pobierzTokeny(), nowe);
  assert.equal(await magazyn.zapiszOdswiezoneTokeny(pierwsze, lease, 'refresh-v1'), false);
});

test('zapis tokenów odrzuca nieprawidłowe dane', async () => {
  const { magazyn } = utworzMagazyn();
  await assert.rejects(magazyn.zapiszTokeny({ access_token: 'a', refresh_token: '', expires_at: 1 }), /tokenów/);
  await assert.rejects(magazyn.zainicjujTokeny({ access_token: 'a', refresh_token: 'r', expires_at: 0 }), /tokenów/);
});

test('alarm usuwa wygasłe tokeny i ustawia termin kolejnego czyszczenia', async () => {
  const { magazyn, dane, pobierzAlarm } = utworzMagazyn();
  await magazyn.zapisz(token, 'oauth-state', { verifier: 'pkce' }, Date.now() + 60_000);
  const pierwszyAlarm = pobierzAlarm();
  assert.ok(pierwszyAlarm > Date.now());
  await magazyn.zapisz('ZyXwVuTsRqPoNmLkJiHgFeDc', 'link-start', { discord_id: '12345678901234567' }, Date.now() + 120_000);
  assert.equal(pobierzAlarm(), pierwszyAlarm, 'nowy token nie może przesuwać wcześniejszego alarmu');
  await magazyn.alarm();
  assert.equal(dane.size, 2);
});

test('zuzyj nie zwraca danych, jeśli lease wygasł przed zatwierdzeniem', async () => {
  const { magazyn } = utworzMagazyn();
  const zegar = Date.now;
  let teraz = zegar();
  Date.now = () => teraz;
  try {
    await magazyn.zapisz(token, 'oauth-state', { verifier: 'pkce' }, teraz + 60_000);
    const zakoncz = magazyn.zakoncz.bind(magazyn);
    magazyn.zakoncz = async (...args) => {
      teraz += 31_000;
      return zakoncz(...args);
    };
    assert.equal(await magazyn.zuzyj(token, 'oauth-state'), null);
  } finally {
    Date.now = zegar;
  }
});
