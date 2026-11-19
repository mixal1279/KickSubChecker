# Cloudflare staging — KickSubChecker

## Zasoby i izolacja

Staging ma osobne zasoby Cloudflare utworzone 2026-11-19:

- Worker: `kick-auth-staging` (osobny skrypt, nie wdrożony).
- D1: `kick-sub-checker-staging`, ID `f3bfc99f-7d6b-4c3d-98bb-f47b3ebc445b`, region/jurysdykcja EU.
- KV: `KICK_SUB_CHECKER_STAGING`, ID `c27d49388a2543c6a681746ace9ca76c`.
- Durable Objects: osobny namespace SQLite zostanie utworzony dla skryptu staging przy pierwszym wdrożeniu migracji `v1`.

Konfiguracja staging jest w `wrangler.staging.toml`. Nie używa żadnego produkcyjnego ID D1/KV ani produkcyjnego skryptu `kick-auth`. Nie kopiuj do niej danych KV, tokenów OAuth ani sekretów produkcyjnych.

Baza `kick-sub-checker-test` pozostaje osobnym zasobem używanym przez testy integracyjne D1. Nie używaj jej jako stagingu aplikacji.

## Wymagane działania operatora

Worker `kick-auth-staging` został już wysłany przez Cloudflare API. Cloudflare utworzył osobny SQLite Durable Object namespace. Workers.dev pozostaje wyłączony do czasu ustawienia sekretu administratora. Worker ma wyłącznie stagingowe bindingi:

- KV: `KICK_SUB_CHECKER_STAGING`
- D1: `kick-sub-checker-staging` (`D1_ENABLED=false`)
- DO: osobny namespace `OAuthTokenStore`
- `MIGRATION_WRITE_FREEZE=true`
- brak sekretów produkcyjnych

Do samego smoke testu DO nie jest potrzebny `KICK_BROADCASTER_ID`, aplikacja Kick ani migracje D1. Placeholder `SET_BY_OPERATOR` może pozostać. `REDIRECT_URI` jest już ustawiony na zweryfikowany adres:

`https://kick-auth-staging.michalkowalczyk489.workers.dev/callback`

1. Ustaw nowy, losowy i unikalny sekret administratora staging:

   ```bash
   npx wrangler secret put ADMIN_API_SECRET --config wrangler.staging.toml
   ```

   Nie używaj sekretu produkcyjnego. Sekret nie może być równy `BOT_API_SECRET`.

2. Wykonaj dry-run konfiguracji, a następnie włącz stagingowy Worker na workers.dev:

   ```bash
   npx wrangler deploy --dry-run --config wrangler.staging.toml
   npx wrangler deploy --config wrangler.staging.toml
   ```

   Obie komendy muszą jawnie wskazywać `wrangler.staging.toml`. Nie używaj `wrangler.toml`, `--env production` ani komend wdrażających produkcyjny Worker. Migracja DO `v1` jest już utworzona dla staging; nie zmieniaj jej tagu.

3. Uruchom testy rzeczywistego staging namespace DO. Endpoint wymaga `STAGING_DO_TESTS=true` oraz `ADMIN_API_SECRET` i nie istnieje w produkcyjnym entrypoincie:

   ```bash
   curl -X POST 'https://kick-auth-staging.michalkowalczyk489.workers.dev/__staging/do-smoke-test' \
     -H "Authorization: Bearer $ADMIN_API_SECRET" \
     -H 'Content-Type: application/json' \
     -d '{"phase":"exercise"}'
   ```

   Test wykonuje na rzeczywistych DO: zapis/odczyt SQLite, wyłączność równoległych lease, równoległy CAS refresh tokena i odrzucenie zapisu przez starego właściciela po wygaśnięciu lease.

4. Trwałość pomiędzy osobnymi żądaniami sprawdź dwoma wywołaniami z tym samym losowym `test_id` (32 małe znaki hex):

   ```bash
   curl -X POST 'https://kick-auth-staging.michalkowalczyk489.workers.dev/__staging/do-smoke-test' \
     -H "Authorization: Bearer $ADMIN_API_SECRET" -H 'Content-Type: application/json' \
     -d '{"phase":"write","test_id":"0123456789abcdef0123456789abcdef"}'

   curl -X POST 'https://kick-auth-staging.michalkowalczyk489.workers.dev/__staging/do-smoke-test' \
     -H "Authorization: Bearer $ADMIN_API_SECRET" -H 'Content-Type: application/json' \
     -d '{"phase":"read","test_id":"0123456789abcdef0123456789abcdef"}'
   ```

   Drugi request musi zwrócić `persisted: true`. To potwierdza trwałość między requestami, ale nie wymusza fizycznej evikcji obiektu.

5. Dopiero przed testami D1 wykonaj migracje wyłącznie na staging D1:

   ```bash
   npx wrangler d1 migrations apply kick-sub-checker-staging --remote --config wrangler.staging.toml
   ```

6. Przed testami OAuth/webhooków utwórz osobną aplikację Kick dla staging, zarejestruj dokładny `REDIRECT_URI`, ustaw rzeczywisty broadcaster ID testowego kanału i osobne sekrety:

   ```bash
   npx wrangler secret put KICK_CLIENT_ID --config wrangler.staging.toml
   npx wrangler secret put KICK_CLIENT_SECRET --config wrangler.staging.toml
   npx wrangler secret put BOT_API_SECRET --config wrangler.staging.toml
   ```

   Nie używaj produkcyjnego konta, kanału ani sekretów.

## Kolejność testu migracji staging

Konfiguracja startowa ma `D1_ENABLED=false` i `MIGRATION_WRITE_FREEZE=true`. To stan bezpieczny, ale blokuje OAuth callback i webhooki.

1. Po przygotowaniu stagingowych sekretów i identyfikatora testowego kanału ustaw tymczasowo `MIGRATION_WRITE_FREEZE=false` i wdroż staging ponownie.
2. Wykonaj OAuth właściciela wyłącznie na testowym kanale. Nie rejestruj webhooków na produkcyjnym kanale.
3. Wykonaj dry-run migracji i sprawdź raport.
4. Ustaw `MIGRATION_WRITE_FREEZE=true`, wdroż tę konfigurację i odczekaj co najmniej 2 minuty na drain żądań in-flight.
5. Uruchom autoryzowaną migrację staging. Wymaga ona jawnego freeze; produkcyjna D1/KV nie są do niej podłączone.
6. Dopiero po potwierdzeniu kompletności D1 oraz obu stanów DO ustaw jednocześnie `D1_ENABLED=true` i `MIGRATION_WRITE_FREEZE=false`, po czym ponownie wdroż staging.

Nie wykonuj rejestracji webhooków bez osobnego planu testu z dedykowanym kontem Kick. Nie uruchamiaj produkcyjnego cutoveru w ramach tej procedury.

## Ograniczenia dowodowe

- Lokalny `npm run test:do` sprawdza runtime `workerd`, a nie wdrożony namespace.
- Samo utworzenie D1/KV nie tworzy namespace DO; powstanie on przy wdrożeniu `kick-auth-staging` z migracją SQLite.
- Staging nie jest wdrożony ani nie ma ustawionych sekretów. Przed wykonaniem testów runtime w infrastrukturze Cloudflare wymagane są powyższe działania operatora.
