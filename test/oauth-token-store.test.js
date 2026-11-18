import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { OAuthTokenStore } from '../oauth-token-store.js';

function utworzMagazyn() {
  const dane = new Map();
  let alarm = null;
  const sql = {
    exec(tekst, ...args) {
      const q = tekst.replace(/\\s+/g, ' ').trim().toUpperCase();
      if (q.startsWith('CREATE TABLE') || q.startsWith('CREATE INDEX')) return { toArray: () => [] };
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
        try { return fn(); } catch (error) {
          dane.clear();
          for (const [klucz, wartosc] of kopia) dane.set(klucz, wartosc);
          throw error;
        }
      },
      async setAlarm(czas) { alarm = czas; },
      async getAlarm() { return alarm; },
    },
  };
  const magazyn = new OAuthTokenStore(ctx, {});
  return { magazyn, dane, pobierzAlarm: () => alarm };
}

const token = 'AbCdEfGhIjKlMnOpQrStUvWx';

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
