# Kick Sub Checker

Projekt ma dwie osobne części: `KickSubChecker.js` to bot Discord (Node.js), a `index.js` to Cloudflare Worker. Worker przyjmuje webhooki Kick, przechowuje stan subskrypcji w KV i udostępnia chronione API botowi. Konto Kick użytkownika jest wiązane z Discordem przez OAuth — ręczne wpisanie nicku nie nadaje uprawnień.

## Wymagania
- Node.js 18.17 lub nowszy i npm na hostingu bota.
- Konto Cloudflare, Wrangler (`npm install -g wrangler`) i KV namespace.
- Aplikacja Kick Developer z poprawnym Redirect URI.
- Bot Discord z włączonym **Server Members Intent** oraz uprawnieniami View Channels, Manage Roles; jego najwyższa rola musi być wyższa niż rola subskrybenta.

## 1. Cloudflare Worker

1. W katalogu projektu zaloguj Wrangler: `npx wrangler login`.
2. Utwórz namespace: `npx wrangler kv namespace create SUBS_KV`.
3. Wklej otrzymane ID do `wrangler.toml` zamiast `REPLACE_WITH_REAL_KV_NAMESPACE_ID`.
4. Utwórz aplikację na https://dev.kick.com. W jej ustawieniach ustaw Redirect URI dokładnie na `https://TWOJ-WORKER.workers.dev/callback`.
5. Ustaw `REDIRECT_URI` w `wrangler.toml` na ten sam adres i zastąp nazwę Workera/host w konfiguracji.
6. Ustaw sekrety. `BOT_API_SECRET` musi być długim losowym sekretem, identycznym w Workerze i w `.env` bota. `ADMIN_API_SECRET` musi być innym, niezależnym sekretem i nie może trafić do konfiguracji bota:

   ```bash
   npx wrangler secret put KICK_CLIENT_ID
   npx wrangler secret put KICK_CLIENT_SECRET
   npx wrangler secret put BOT_API_SECRET
npx wrangler secret put ADMIN_API_SECRET
   ```

7. Przed wdrożeniem sprawdź, czy `wrangler.toml` zawiera prawdziwe ID KV oraz właściwy `REDIRECT_URI`; wartości `REPLACE_WITH_...` są tylko placeholderami.
8. Wdróż Workera: `npx wrangler deploy`.
9. Administrator tworzy jednorazowy link OAuth właściciela kanału przez `POST https://TWOJ-WORKER.workers.dev/api/owner/start` z nagłówkiem `Authorization: Bearer TWÓJ_SEKRET`, a następnie przekazuje zwrócone `url` właścicielowi kanału (np. Ljay). Link jest jednorazowy i wygasa po 10 minutach. Właściciel zatwierdza OAuth.

   ```bash
   curl -X POST 'https://TWOJ-WORKER.workers.dev/api/owner/start' \
     -H 'Authorization: Bearer TWÓJ_SEKRET'
   ```
   Otwórz pole `url` ze zwróconego JSON-a.
10. Zarejestruj eventy metodą POST z nagłówkiem `Authorization: Bearer TWÓJ_SEKRET` na `https://TWOJ-WORKER.workers.dev/register-events`. Endpoint nie jest przeznaczony do otwierania w przeglądarce. Przykład:

   ```bash
   curl -X POST 'https://TWOJ-WORKER.workers.dev/register-events' \
     -H 'Authorization: Bearer TWÓJ_SEKRET'
   ```

11. W panelu Kick Developer włącz webhooks i ustaw adres `https://TWOJ-WORKER.workers.dev/webhook`. Endpoint weryfikuje podpis oraz odrzuca znaczniki czasu starsze niż 5 minut. ID zdarzenia zapisuje jako przetworzone dopiero po udanym zapisie danych; ponowiona dostawa po błędzie może więc dokończyć przetwarzanie.

## 2. Bot Discord

1. Skopiuj `.env.example` do `.env` i uzupełnij `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `WORKER_URL` oraz ten sam `BOT_API_SECRET`, którego używa Worker.
2. Zainstaluj zależności: `npm install`.
3. Sprawdź składnię: `npm run check`. Testy Workera uruchom przez `npm test`.
4. Uruchom bota: `npm start`.
5. Na serwerze Discord użyj `/config-rola` i wybierz rolę subskrybenta.
6. Użytkownicy uruchamiają `/polacz-konto`, otwierają jednorazowy link i logują się do Kick. Nick jest pobierany bezpośrednio z autoryzowanego konta. `/moj-status` pokazuje status. `/sprawdz-suba` pozwala sprawdzić publicznie status nicku, ale nie wiąże go z użytkownikiem. Synchronizacja ról działa co 10 minut; administrator może użyć `/sprawdz-teraz`.

## API Workera
- `GET /authorize?owner_token=...` — jednorazowy OAuth właściciela kanału; link generuje administrator.
- `GET /authorize?link_token=...` — jednorazowy OAuth widza; link generuje `/polacz-konto`.
- `POST /api/owner/start` — tworzy jednorazowy link OAuth właściciela kanału, wymaga Bearer secret.
- `GET /callback` — callback OAuth właściciela albo widza.
- `POST /webhook` — podpisane eventy Kick.
- `POST /register-events` — chroniona rejestracja eventów.
- `GET /api/check?username=nick` — status suba (`active`, `inactive` lub `unknown`), wymaga Bearer secret. Brak rekordu albo niepoprawna data wygaśnięcia zwraca `unknown`, a nie `inactive`.
- `POST /api/link/start` — tworzy jednorazowy link OAuth dla ID Discorda, wymaga Bearer secret.
- `POST /api/admin/migrate-kv` — migracja KV → D1; wymaga osobnego `ADMIN_API_SECRET` (nie `BOT_API_SECRET`), domyślnie wykonuje wyłącznie dry-run. Import uruchamia `?dry_run=false`.
- `GET /api/link?discord_id=ID` i `GET /api/links` — zweryfikowane powiązania, wymagają Bearer secret.

## Ważne ograniczenia
- Kick webhooki informują o nowych subskrypcjach, odnowieniach i prezentach. Przy prezentach korzystamy z `giftees` i wspólnego `expires_at` z payloadu; dokumentacja Kick odnotowywała zgłoszenia nieprawidłowych dat wygaśnięcia w niektórych webhookach, dlatego warto zweryfikować je na rzeczywistym koncie testowym. KV nie odtworzy automatycznie historii sprzed uruchomienia webhooków. Użytkownik może więc być aktywnym subskrybentem, ale nie być jeszcze znany lokalnej bazie. W takim przypadku API zwraca `unknown`, a bot nie zmienia jego roli.
- Bot odbiera rolę tylko wtedy, gdy istnieje zapis subskrypcji z poprawną datą wygaśnięcia, która już minęła. Błąd API, brak rekordu lub niepoprawna data nie powodują odebrania roli.
- Bot nie wykonuje automatycznego sprzątania ról osobom bez połączonego konta Kick. Takie role nie są zdejmowane tylko dlatego, że użytkownik nie ma powiązania OAuth.
- Po wdrożeniu sprawdź testowym kontem, czy Kick wysyła webhooki do ustawionego adresu oraz czy odpowiedź rejestracji eventów jest sukcesem. Nie da się potwierdzić rzeczywistego działania integracji bez Twoich sekretów, konfiguracji Kick Developer i uprawnień serwera.
- Nie commituj `.env`, tokenów OAuth ani sekretów. Jeśli wcześniejsze sekrety były publiczne, wygeneruj nowe.


## Backend v2: Cloudflare D1 bez ponownego OAuth

Backend v2 może przejąć powiązania, subskrypcje i webhooki w D1, ale tokeny właściciela kanału nadal są przechowywane w KV pod istniejącym kluczem `ljay:tokens`. Worker potrafi odczytać tożsamość kanału z obecnego tokenu i odświeżyć go standardowym refresh tokenem. **Samo przełączenie bazy nie wymaga ponownej autoryzacji Kick.**

Szczegółowa, bezpieczna procedura znajduje się w [docs/backend-v2-migration.md](docs/backend-v2-migration.md). Najważniejsze:
- skonfiguruj binding D1 (`DB`) i zastosuj migracje `0001` → `0002` → `0003` → `0004` → `0005` → `0006`;
- instalacja obsługuje jeden kanał Kick i jeden serwer Discord;
- pozostaw `D1_ENABLED = "false"` i wykonaj dry-run endpointu `POST /api/admin/migrate-kv`;
- przed importem włącz `MIGRATION_WRITE_FREEZE = "true"`, wdróż konfigurację i odczekaj co najmniej 2 minuty na zakończenie żądań in-flight;
- podczas freeze Worker blokuje webhooki, callbacki OAuth, tworzenie nowych linków i rejestrację eventów kodem 503; Kick może ponowić webhooki;
- wykonaj import z `?dry_run=false`, sprawdź raport, stare źródła `gift`, `new`, `renewal`, konflikty oraz statusy po nicku i ID;
- w jednym wdrożeniu przełącz `D1_ENABLED = "true"` i `MIGRATION_WRITE_FREEZE = "false"`. Nie zdejmuj freeze przed cutoverem.

Nie usuwaj KV po przełączeniu — nadal przechowuje tokeny OAuth, stan PKCE, jednorazowe linki i cache klucza publicznego. Endpoint migracyjny wymaga osobnego `ADMIN_API_SECRET`. Nie udostępniaj go botowi Discord ani nie używaj ponownie `BOT_API_SECRET`.
