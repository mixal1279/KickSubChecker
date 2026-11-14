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

Migracje SQL nie modyfikują KV. Nie edytuj już zastosowanej migracji 0001 — zmiany schematu wprowadzaj kolejnymi numerowanymi migracjami.

## Kolejność bezpiecznego przełączenia

1. Zastosuj migracje D1 `0001` i `0002` w środowisku docelowym.
2. Ustaw `D1_ENABLED = "false"`. Nie wdrażaj przełączenia na produkcję na tym etapie.
3. Uruchom `POST /api/admin/migrate-kv` (domyślnie dry-run).
4. Sprawdź `links_skipped`, `subscriptions_seen`, `subscriptions_valid` i `errors`. Indeksy `sub:user_id:` są pomijane — importowane są tylko kanoniczne rekordy `sub:<username>`.
5. Uruchom import przez `POST /api/admin/migrate-kv?dry_run=false`. Operacja nie usuwa źródłowych rekordów KV i może być ponawiana.
6. Porównaj liczbę rekordów i sprawdź konta testowe po nicku oraz po ID.
7. Dopiero po walidacji ustaw `D1_ENABLED = "true"` i wykonaj kontrolowane wdrożenie.

Endpoint migracyjny wymaga Bearer secret bota. Nie umieszczaj sekretu w repozytorium ani w logach. KV pozostaje aktywne po przełączeniu, ponieważ nadal przechowuje OAuth i stan pomocniczy.

## Testy wymagane przed cutoverem

- testy adaptera D1 i walidacji danych;
- testy realnego D1 z zastosowanymi migracjami, nie tylko mock;
- testy OAuth: zachowanie refresh tokena i weryfikacja oczekiwanego kanału;
- testy `/api/check` po nicku i po ID;
- testy webhooków: podpis, stary timestamp, duplikat, ponowienie po błędzie i zapis prezentów;
- test migratora na kopii danych z kontrolą źródeł `gift`, `new`, `renewal`;
- retencja D1 usuwa rekordy webhooków starsze niż 30 dni (również porzucone `processing`) raz dziennie; ponowienie zdarzenia `failed` lub porzuconego `processing` nadal zależy od ponownej dostawy webhooka przez Kick (Worker nie przechowuje surowego payloadu do samodzielnego odtworzenia);
- test zgodności endpointów `/ljay-live` i `/preview`.

Nie wdrażaj Workera na produkcję ani nie przełączaj `D1_ENABLED` na podstawie samych testów mockowych.
