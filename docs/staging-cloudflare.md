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

1. Wybierz dedykowane testowe konto/kanał Kick i odczytaj jego rzeczywisty broadcaster ID. Wpisz go do `KICK_BROADCASTER_ID` w `wrangler.staging.toml`. Nie używaj ID produkcyjnego kanału.
2. Utwórz osobną aplikację OAuth Kick dla staging. Ustaw redirect URI zgodny z rzeczywistą domeną workers.dev staging i zarejestruj dokładnie ten sam URI w panelu Kick. Zastąp placeholder `REDIRECT_URI`.
3. Ustaw wyłącznie stagingowe sekrety (nie kopiuj wartości z produkcji):

   ```bash
   npx wrangler secret put KICK_CLIENT_ID --config wrangler.staging.toml
   npx wrangler secret put KICK_CLIENT_SECRET --config wrangler.staging.toml
   npx wrangler secret put BOT_API_SECRET --config wrangler.staging.toml
   npx wrangler secret put ADMIN_API_SECRET --config wrangler.staging.toml
   ```

   `ADMIN_API_SECRET` musi być niezależny od `BOT_API_SECRET`.

4. Przed wdrożeniem zweryfikuj plik konfiguracyjny:

   ```bash
   npx wrangler deploy --dry-run --config wrangler.staging.toml
   ```

5. Zastosuj migracje wyłącznie do staging D1:

   ```bash
   npx wrangler d1 migrations apply kick-sub-checker-staging --remote --config wrangler.staging.toml
   ```

6. Wykonaj pierwsze wdrożenie wyłącznie przez osobny plik:

   ```bash
   npx wrangler deploy --config wrangler.staging.toml
   ```

   Nie używaj `wrangler.toml`, `--env production`, `wrangler deploy` bez jawnego `--config` ani komend z produkcyjnym skryptem.

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
