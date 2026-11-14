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
