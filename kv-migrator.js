/**
 * Pobiera token do migracji bez ukrytych efektów ubocznych w trybie dry-run.
 * Dry-run korzysta wyłącznie z ważnego access tokena już zapisanego w KV.
 */
export async function pobierzTokenMigracji({ env, dryRun, odswiezToken, teraz = Date.now() }) {
  if (!env?.SUBS_KV || typeof env.SUBS_KV.get !== 'function') {
    throw new TypeError('Brak magazynu KV dla migratora.');
  }

  const zapisane = await env.SUBS_KV.get('ljay:tokens', 'json');
  if (
    zapisane
    && typeof zapisane.access_token === 'string'
    && zapisane.access_token
    && Number.isFinite(Number(zapisane.expires_at))
    && Number(zapisane.expires_at) > teraz + 60_000
  ) {
    return zapisane.access_token;
  }

  if (dryRun) {
    throw new Error('dry_run_requires_valid_access_token');
  }
  if (typeof odswiezToken !== 'function') {
    throw new TypeError('Brak funkcji odświeżania tokenu OAuth.');
  }

  return odswiezToken(env);
}
