import test from 'node:test';
import assert from 'node:assert/strict';
import { OAuthTokenStore } from '../oauth-token-store.js';

function utworzMagazyn() {
  const dane = new Map();
  let kolejka = Promise.resolve();
  const ctx = {
    storage: {
      transaction(fn) {
        const wynik = kolejka.then(() => fn({
          async get(klucz) { return dane.get(klucz); },
          async put(klucz, wartosc) { dane.set(klucz, structuredClone(wartosc)); },
          async delete(klucz) { return dane.delete(klucz); },
        }));
        kolejka = wynik.then(() => undefined, () => undefined);
        return wynik;
      },
    },
  };
  return new OAuthTokenStore(ctx, {});
}

const token = 'AbCdEfGhIjKlMnOpQrStUvWx';

test('token można zużyć dokładnie jeden raz', async () => {
  const magazyn = utworzMagazyn();
  const dane = { verifier: 'sekret-pkce', discord_id: '12345678901234567' };
  await magazyn.zapisz(token, 'oauth-state', dane, Date.now() + 60_000);
  const wyniki = await Promise.all([
    magazyn.zuzyj(token, 'oauth-state'),
    magazyn.zuzyj(token, 'oauth-state'),
  ]);
  assert.equal(wyniki.filter(Boolean).length, 1);
  assert.deepEqual(wyniki.find(Boolean), dane);
});

test('token wygasły jest usuwany i nie może być użyty', async () => {
  const magazyn = utworzMagazyn();
  await magazyn.zapisz(token, 'owner-start', { created_at: 1 }, 10_000);
  assert.equal(await magazyn.zuzyj(token, 'owner-start', 10_000), null);
  assert.equal(await magazyn.zuzyj(token, 'owner-start', 10_001), null);
});

test('token o innym typie jest kasowany bez ujawnienia danych', async () => {
  const magazyn = utworzMagazyn();
  await magazyn.zapisz(token, 'link-start', { discord_id: '12345678901234567' }, Date.now() + 60_000);
  assert.equal(await magazyn.zuzyj(token, 'oauth-state'), null);
  assert.equal(await magazyn.zuzyj(token, 'link-start'), null);
});

test('nie pozwala nadpisać istniejącego tokena', async () => {
  const magazyn = utworzMagazyn();
  await magazyn.zapisz(token, 'oauth-state', { verifier: 'pierwszy' }, Date.now() + 60_000);
  await assert.rejects(
    magazyn.zapisz(token, 'oauth-state', { verifier: 'drugi' }, Date.now() + 60_000),
    /już istnieje/,
  );
  assert.deepEqual(await magazyn.zuzyj(token, 'oauth-state'), { verifier: 'pierwszy' });
});

test('odrzuca nieprawidłowe dane wejściowe przed zapisem', async () => {
  const magazyn = utworzMagazyn();
  await assert.rejects(magazyn.zapisz('krótki', 'oauth-state', {}, Date.now() + 60_000), /token/);
  await assert.rejects(magazyn.zapisz(token, 'nieznany', {}, Date.now() + 60_000), /typ tokena/);
  await assert.rejects(magazyn.zapisz(token, 'oauth-state', {}, Date.now() - 1), /wygaśnięcia/);
});
