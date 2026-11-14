# Backend v2 — plan migracji

## Założenia

- Dane trwałe są izolowane przez `broadcaster_id`; rekord jednego kanału Kick nie może wpływać na inny kanał.
- Konfiguracja roli jest przypisana do pary kanał Kick + serwer Discord.
- W ramach jednego kanału konto Discord i konto Kick mogą być powiązane maksymalnie raz.
- Identyfikator Kick jest kluczem subskrybenta; gdy webhook nie dostarczy ID, adapter może użyć klucza `name:<lowercase-username>`.
- OAuth state, jednorazowe linki i cache klucza publicznego pozostają krótkotrwałymi wpisami KV.
- Tokeny OAuth nie trafiają do tabel biznesowych ani logów. Do czasu osobnego przeglądu pozostają w istniejącym magazynie KV.
- Status `unknown` nie może skutkować odebraniem roli.

## Migracja 0001

Plik `migrations/0001_backend_v2.sql` tworzy tabele:
- `channels` — kanały Kick obsługiwane przez instalację;
- `guild_configs` — konfiguracja ról per kanał i serwer Discord;
- `account_links` — zweryfikowane powiązania kont;
- `subscriptions` — ostatni znany stan subskrypcji;
- `webhook_events` — deduplikacja i stan przetwarzania webhooków;
- `audit_log` — ślad operacji administracyjnych i systemowych.

Migracja jest idempotentna i nie usuwa ani nie modyfikuje istniejących danych KV.

## Kolejność przełączenia

1. Utworzyć bazę D1 i zastosować migrację.
2. Dodać adapter repozytorium D1 z parametryzowanymi zapytaniami.
3. Przepisać zapis powiązań tak, aby oba kierunki były aktualizowane w jednej transakcji.
4. Przepisać obsługę webhooków: atomowo zgłosić event, zapisać subskrypcje i oznaczyć event jako przetworzony; awaria nie może pozostawić fałszywego sukcesu.
5. Dodać migrator KV → D1 z trybem dry-run, raportem konfliktów i możliwością bezpiecznego ponowienia.
6. Dopiero po porównaniu danych przełączyć odczyty na D1. KV pozostawić jako rollback/read-only przez uzgodniony okres.

## Ważne

Ta zmiana dodaje schemat i plan migracji. Nie przełącza jeszcze działającego Workera na D1 i nie wymaga zmiany sekretów ani konfiguracji produkcyjnej. Nie uruchamiaj migracji przed utworzeniem bazy D1.


## Adapter D1

Plik `d1-repository.js` udostępnia repozytorium bez zależności zewnętrznych:
- `zapiszKanal`, `ustawRole`, `pobierzRole` — konfiguracja per kanał i guild;
- `polaczKonto`, `odlaczKonto`, `pobierzPowiazanie`, `pobierzPowiazania` — operacje na powiązaniach;
- `zapiszSubskrypcje`, `sprawdzSubskrypcje` — zapis i odczyt stanu subskrypcji;
- `przejmijWebhook`, `zakonczWebhook`, `oznaczWebhookNieudany` — kontrola przetwarzania webhooków.

Łączenie kont używa D1 batch: usunięcie poprzedniego powiązania Discord i wstawienie nowego wraz z audytem są jedną operacją transakcyjną. Konflikt unikalnego ID Kick powoduje wycofanie całej paczki. Webhook otrzymuje atomowy claim przez `INSERT OR IGNORE`; ponowne przejęcie jest możliwe po błędzie lub po 5 minutach bezczynnego statusu `processing`. Zapisy subskrypcji są ograniczone do eventu w stanie `processing`, a data wygaśnięcia nigdy nie jest cofana.

Testy adaptera znajdują się w `test/d1-repository.test.js`. Adapter nie jest jeszcze podłączony do routingu Workera — aktualny kod nadal korzysta z KV. Przed przełączeniem trzeba dodać konfigurację bindingu D1, przepiąć endpointy i webhook, a następnie wykonać migrator KV → D1.


## Zachowanie OAuth i przełączenie Workera

Tokeny właściciela kanału pozostają w KV pod dotychczasowym kluczem `ljay:tokens`. Nie kopiujemy ich do D1 i nie zmieniamy formatu rekordu. Przy braku zapisanego `config:broadcaster_id` Worker pobiera tożsamość kanału przez istniejący access token (w razie potrzeby odświeża go refresh tokenem), zapisuje ID kanału w KV i inicjalizuje rekord `channels`. Ta ścieżka nie wymaga ponownego OAuth.

D1 jest za bramką `D1_ENABLED`. Domyślna wartość to `false`, więc samo dodanie bindingu nie przełącza odczytów ani zapisów aplikacyjnych na pustą bazę.

### Konfiguracja

1. Utwórz D1: `npx wrangler d1 create kick-sub-checker`.
2. Wstaw otrzymane `database_id` do `wrangler.toml` w bindingu `DB`.
3. Zastosuj schemat: `npx wrangler d1 migrations apply kick-sub-checker --remote` (jeśli korzystasz z katalogu migrations, upewnij się, że plik SQL jest w katalogu migracji Wrangler; alternatywnie wykonaj SQL przez `wrangler d1 execute`).
4. Wdróż Workera z `D1_ENABLED = "false"`.
5. Wykonaj najpierw dry-run:
   `curl -X POST 'https://TWOJ-WORKER/api/admin/migrate-kv' -H 'Authorization: Bearer TWÓJ_SEKRET'`
   Domyślnie endpoint tylko liczy i waliduje rekordy. Nie zapisuje danych biznesowych do D1.
6. Jeśli raport jest poprawny, wykonaj import:
   `curl -X POST 'https://TWOJ-WORKER/api/admin/migrate-kv?dry_run=false' -H 'Authorization: Bearer TWÓJ_SEKRET'`
   Import jest ponawialny. Konflikty i niepoprawne rekordy trafiają do raportu; nie usuwamy źródłowych danych KV.
7. Zweryfikuj liczbę rekordów i testowe konta, a dopiero potem ustaw `D1_ENABLED = "true"` i wdróż ponownie.

Po przełączeniu Worker obsługuje API bota, powiązania i webhooki przez D1. OAuth state, jednorazowe linki, cache klucza publicznego i tokeny właściciela nadal pozostają w KV. Nie usuwaj KV po cutoverze.

**Ograniczenie migratora:** rekordy powiązań bez `kick_user_id` są pomijane, ponieważ D1 wymaga stabilnego ID zweryfikowanego konta. Migrator nie usuwa ani nie nadpisuje źródłowych kluczy KV. Przed włączeniem D1 trzeba przejrzeć `links_skipped` i `errors`.
