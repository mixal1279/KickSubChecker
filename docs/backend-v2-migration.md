# Backend v2 — migracja KV → D1

## Docelowa instalacja

Ta instalacja obsługuje dokładnie:
- jeden kanał Kick, identyfikowany przez `broadcaster_id`;
- jeden serwer Discord, identyfikowany przez `guild_id`;
- jedną rolę subskrybenta na tym serwerze.

Nie implementujemy multi-channel ani multi-guild. Bot zapisuje `guildId` i `roleId` w swoim lokalnym `config.json`; konfiguracja roli nie jest obecnie odczytywana z tabeli `guild_configs`. Komendy konfiguracyjne muszą blokować zmianę serwera po pierwszej konfiguracji.

Dane subskrypcji, zweryfikowane powiązania kont i deduplikacja webhooków są w D1, zawsze z kluczem `broadcaster_id`. OAuth state, jednorazowe linki, klucz publiczny i tokeny właściciela pozostają w KV. Tokeny nie trafiają do D1 ani logów.

## Kompatybilność z działającym Workerem

Zmiana zachowuje endpointy:
- `/ljay-live` i `/ljay-live/start` — OAuth dla kanału `ljaylive`;
- `/preview` — strona podglądu;
- `/authorize`, `/callback`, `/webhook`, `/register-events`;
- dotychczasowe endpointy `/api/*`.

`/api/check` obsługuje zarówno `username`, jak i `user_id`. Odczyt po ID ma pierwszeństwo, a odpowiedź zachowuje format statusu `active`, `inactive` lub `unknown`. KV utrzymuje indeksy `sub:<username>` i `sub:user_id:<id>`.

Odświeżanie OAuth zachowuje poprzedni refresh token, jeśli Kick nie zwróci nowego. Przy pierwszym ustaleniu kanału Worker potwierdza ID przez autoryzowany endpoint Kick. Callback właściciela nie zapisze tokenów ani konfiguracji, jeśli ID autoryzowanego konta różni się od istniejącego `config:broadcaster_id` lub `KICK_BROADCASTER_ID`. Zmiana kanału wymaga osobnej procedury.

## Migracje SQL

- `0001_backend_v2.sql` tworzy tabele kanałów, konfiguracji, powiązań, subskrypcji, webhooków i audytu.
- `0002_legacy_subscription_sources.sql` rozszerza dozwolone źródła subskrypcji, zachowując rekordy już zapisane w D1. Wspiera stare wartości `gift`, `new`, `renewal` oraz nowe nazwy eventów Kick.
- `0003_require_broadcaster_id.sql` dodaje triggery blokujące `NULL` w `channels.broadcaster_id` przy INSERT i UPDATE. Nie przebudowuje tabel ani nie modyfikuje istniejących rekordów.

Migracje SQL nie modyfikują KV. Nie edytuj już zastosowanych migracji — zmiany schematu wprowadzaj kolejnymi numerowanymi migracjami. Migracje należy wykonywać dokładnie raz i zapisywać ich zastosowanie w dokumentacji wdrożenia; repozytorium nie ma jeszcze automatycznego rejestru migracji.

## Testy integracyjne D1

Test `test/d1-remote.integration.test.js` łączy się z Cloudflare D1 przez REST API i sprawdza rzeczywiste ograniczenia SQL, dozwolone źródła subskrypcji, unikalność powiązań, deduplikację webhooków, klucze obce oraz `ON DELETE CASCADE`.

Test celowo odmawia pracy na produkcyjnej bazie i dodatkowo sprawdza, czy wskazana baza ma dokładną nazwę `kick-sub-checker-test`. Bez kompletu zmiennych środowiskowych test jest pomijany.

W GitHub Actions dodaj sekrety repozytorium:
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN` — token z uprawnieniami do odczytu metadanych D1 oraz wykonywania zapytań D1;
- `D1_TEST_DATABASE_ID` — ID bazy `kick-sub-checker-test`, nigdy produkcyjnej.

Lokalnie ustaw te same zmienne środowiskowe i uruchom `npm test`. Test używa wyłącznie danych tymczasowych z unikalnym `broadcaster_id` i usuwa je w bloku `finally`.

## Kolejność bezpiecznego przełączenia

1. Zastosuj migracje D1 `0001`, `0002` i `0003` w środowisku docelowym.
2. Ustaw `D1_ENABLED = "false"`. Nie wdrażaj przełączenia na produkcję na tym etapie.
3. Uruchom `POST /api/admin/migrate-kv` (domyślnie dry-run).
4. Sprawdź `links_skipped`, `subscriptions_seen`, `subscriptions_valid` i `errors`. Indeksy `sub:user_id:` są pomijane — importowane są tylko kanoniczne rekordy `sub:<username>`.
5. Uruchom import przez `POST /api/admin/migrate-kv?dry_run=false`. Operacja nie usuwa źródłowych rekordów KV i może być ponawiana.
6. Porównaj liczbę rekordów i sprawdź konta testowe po nicku oraz po ID.
7. Dopiero po walidacji ustaw `D1_ENABLED = "true"` i wykonaj kontrolowane wdrożenie.

Endpoint migracyjny wymaga osobnego `ADMIN_API_SECRET`, niezależnego od `BOT_API_SECRET` i nieudostępnianego botowi. Nie umieszczaj sekretów w repozytorium ani w logach. Ustaw go w Cloudflare jako secret przed użyciem endpointu. KV pozostaje aktywne po przełączeniu, ponieważ nadal przechowuje OAuth i stan pomocniczy.


## Dodatkowe zabezpieczenia webhooków

Worker przed zapisem zdarzenia sprawdza:
- `Kick-Event-Version: 1` oraz jeden z trzech obsługiwanych typów subskrypcji;
- `payload.broadcaster.user_id` zgodny z kanałem skonfigurowanym w KV;
- poprawność identyfikatorów użytkowników w payloadzie;
- limit rozmiaru payloadu liczony w bajtach.

Rejestracja eventów przekazuje `broadcaster_user_id` do Kick i wymaga dokładnie trzech poprawnych odpowiedzi z `name`, `version` oraz `subscription_id`. Identyfikatory subskrypcji są zapisywane w KV. Webhook musi zawierać `Kick-Event-Subscription-Id` zgodny z identyfikatorem zarejestrowanym dla danego typu eventu. To dodatkowo wiąże dostawę z subskrypcją tej aplikacji, ponieważ Kick nie obejmuje tego nagłówka podpisem. Po wdrożeniu tej zmiany administrator musi ponownie wykonać `POST /register-events`; do tego czasu dotychczasowe webhooki będą odrzucane. Samo HTTP 200 nie jest dowodem, że wszystkie subskrypcje zostały utworzone.

Repozytorium D1 aktualizuje nick, ID, źródło i znacznik czasu subskrypcji tylko wtedy, gdy przychodzący event nie jest starszy od zapisanego rekordu. Starszy event nie może cofnąć metadanych nowszej subskrypcji.

## Jednorazowość OAuth — Durable Objects

Tokeny `oauth-state`, `owner-start` i `link-start` są przechowywane w shardowanym Durable Object. Shard jest wybierany deterministycznie z pierwszego znaku losowego tokena, dzięki czemu operacje dla jednego tokena trafiają do tej samej instancji bez kierowania całego ruchu do jednego globalnego obiektu. Zapis, rezerwacja, zwolnienie i zużycie wykonują się w transakcjach Durable Object. Callback OAuth najpierw uzyskuje krótką rezerwację (lease), więc tylko jedno równoległe żądanie może wymieniać dany kod. Po błędzie wymiany rezerwacja jest zwalniana; po sukcesie token jest definitywnie zużywany. Awaria procesu zwalnia token do ponowienia po wygaśnięciu 120-sekundowej rezerwacji. Tokeny startowe linkowania i właściciela są konsumowane atomowo w jednej transakcji.

Po dodaniu bindingu wymagane jest wdrożenie migracji `v1` Durable Object. Stare, jeszcze aktywne linki zapisane w KV nie będą rozpoznawane przez nową ścieżkę — przed przełączeniem należy odczekać co najmniej 10 minut od wydania ostatnich linków albo unieważnić je i wygenerować ponownie. Nie wdrażaj konfiguracji produkcyjnej bez wcześniejszego sprawdzenia namespace i migracji w środowisku testowym.


## Testy wymagane przed cutoverem

- testy adaptera D1 i walidacji danych;
- testy integracyjne z prawdziwym D1 opisane wyżej;
- testy OAuth: zachowanie refresh tokena i weryfikacja oczekiwanego kanału;
- testy `/api/check` po nicku i po ID;
- testy webhooków: podpis, stary timestamp, duplikat, ponowienie po błędzie i zapis prezentów;
- test migratora na kopii danych z kontrolą źródeł `gift`, `new`, `renewal`;
- retencja D1 usuwa rekordy webhooków starsze niż 30 dni (również porzucone `processing`) raz dziennie; ponowienie zdarzenia `failed` lub porzuconego `processing` nadal zależy od ponownej dostawy webhooka przez Kick (Worker nie przechowuje surowego payloadu do samodzielnego odtworzenia);
- test zgodności endpointów `/ljay-live` i `/preview`.

Nie wdrażaj Workera na produkcję ani nie przełączaj `D1_ENABLED` na podstawie samych testów mockowych.
