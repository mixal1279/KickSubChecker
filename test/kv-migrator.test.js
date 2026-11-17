import test from 'node:test';
import assert from 'node:assert/strict';
import { pobierzTokenMigracji } from '../kv-migrator.js';

function utworzEnv(tokeny) {
  const zapisy = [];
  return {
    zapisy,
    SUBS_KV: {
      async get(klucz, typ) {
        assert.equal(klucz, 'ljay:tokens');
        return typ === 'json' ? tokeny : JSON.stringify(tokeny);
      },
      async put(klucz, wartosc) {
        zapisy.push({ klucz, wartosc });
      },
    },
  };
}

test('dry-run używa ważnego access tokena bez zapisu do KV', async () => {
  const env = utworzEnv({ access_token: 'valid-token', expires_at: Date.now() + 300_000 });
  let odswiezenia = 0;
  const token = await pobierzTokenMigracji({
    env, dryRun: true,
    odswiezToken: async () => { odswiezenia++; return 'refreshed-token'; },
  });
  assert.equal(token, 'valid-token');
  assert.equal(odswiezenia, 0);
  assert.deepEqual(env.zapisy, []);
});

test('dry-run odrzuca wygasły token zamiast odświeżać OAuth', async () => {
  const env = utworzEnv({ access_token: 'expired-token', refresh_token: 'refresh-secret', expires_at: Date.now() - 1 });
  let odswiezenia = 0;
  await assert.rejects(
    pobierzTokenMigracji({
      env, dryRun: true,
      odswiezToken: async () => { odswiezenia++; return 'refreshed-token'; },
    }),
    /dry_run_requires_valid_access_token/,
  );
  assert.equal(odswiezenia, 0);
  assert.deepEqual(env.zapisy, []);
});

test('import może odświeżyć token, jeśli access token wygasł', async () => {
  const env = utworzEnv({ access_token: 'expired-token', refresh_token: 'refresh-secret', expires_at: 1 });
  let odswiezenia = 0;
  const token = await pobierzTokenMigracji({
    env, dryRun: false,
    odswiezToken: async () => { odswiezenia++; return 'new-access-token'; },
  });
  assert.equal(token, 'new-access-token');
  assert.equal(odswiezenia, 1);
  assert.deepEqual(env.zapisy, []);
});

test('odrzuca brak magazynu KV', async () => {
  await assert.rejects(
    pobierzTokenMigracji({ env: {}, dryRun: true }),
    /magazynu KV/,
  );
});
