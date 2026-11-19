import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function utworzStub(nazwa) {
  return env.OAUTH_TOKENS.getByName(`test-${nazwa}-${crypto.randomUUID()}`);
}

describe("OAuthTokenStore — runtime workerd i SQLite", () => {
  it("inicjalizuje wszystkie tabele SQLite w nowej instancji", async () => {
    const stub = utworzStub("schema");

    const tabele = await runInDurableObject(stub, (_instancja, stan) =>
      stan.storage.sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      ).toArray().map((wpis) => wpis.name));

    expect(tabele).toEqual([
      "cutover_registry",
      "cutover_state",
      "oauth_credentials",
      "oauth_locks",
      "oauth_tokens",
    ]);
    await expect(stub.pobierzTokeny()).resolves.toBeNull();
    await expect(stub.pobierzGlobalnyStanCutoveru()).resolves.toBeNull();
  });

  it("wycofuje wszystkie zapisy transakcji po wyjątku", async () => {
    const stub = utworzStub("rollback");

    const blad = await runInDurableObject(stub, (_instancja, stan) => {
      try {
        stan.storage.transactionSync(() => {
          stan.storage.sql.exec(
            "INSERT INTO cutover_registry (id, broadcaster_id, backend) VALUES (1, ?, 'd1')",
            "123456",
          );
          throw new Error("symulowany błąd transakcji");
        });
        return null;
      } catch (error) {
        return error.message;
      }
    });

    expect(blad).toBe("symulowany błąd transakcji");
    await expect(stub.pobierzGlobalnyStanCutoveru()).resolves.toBeNull();
  });

  it("przy równoległych próbach przyznaje tylko jedną blokadę", async () => {
    const stub = utworzStub("concurrency");

    const wyniki = await Promise.all(
      Array.from({ length: 24 }, () => stub.zarezerwujBlokade("odswiezanie", 30_000)),
    );

    expect(wyniki.filter(Boolean)).toHaveLength(1);
    expect(wyniki.filter((wynik) => wynik === null)).toHaveLength(23);
  });

  it("utrzymuje wyłączność jednorazowego tokena przy równoległych rezerwacjach", async () => {
    const stub = utworzStub("token-race");
    const token = `tok_${crypto.randomUUID().replaceAll("-", "")}`;
    const dane = { broadcaster_id: "123456", state: "wartosc-testowa" };

    await stub.zapisz(token, "oauth-state", dane, Date.now() + 60_000);
    const rezerwacje = await Promise.all(
      Array.from({ length: 20 }, () => stub.zarezerwuj(token, "oauth-state", 30_000)),
    );

    const udane = rezerwacje.filter(Boolean);
    expect(udane).toHaveLength(1);
    expect(udane[0].dane).toEqual(dane);
    expect(await stub.zarezerwuj(token, "oauth-state", 30_000)).toBeNull();
  });

  it("inicjalizuje tokeny właściciela bez nadpisywania istniejących poświadczeń", async () => {
    const stub = utworzStub("owner-init");
    const pierwsze = {
      access_token: "access-pierwszy",
      refresh_token: "refresh-pierwszy",
      expires_at: Date.now() + 60_000,
    };
    const drugie = {
      access_token: "access-drugi",
      refresh_token: "refresh-drugi",
      expires_at: Date.now() + 120_000,
    };

    await expect(stub.zainicjujTokeny(pierwsze)).resolves.toEqual(pierwsze);
    await expect(stub.zainicjujTokeny(drugie)).resolves.toEqual(pierwsze);
    await expect(stub.pobierzTokeny()).resolves.toEqual(pierwsze);
  });

  it("rotuje token właściciela tylko z aktywną blokadą i zgodnym refresh tokenem", async () => {
    const stub = utworzStub("owner-refresh");
    const obecne = {
      access_token: "access-stary",
      refresh_token: "refresh-stary",
      expires_at: Date.now() + 60_000,
    };
    const nowe = {
      access_token: "access-nowy",
      refresh_token: "refresh-nowy",
      expires_at: Date.now() + 120_000,
    };

    await stub.zainicjujTokeny(obecne);
    await expect(
      stub.zapiszOdswiezoneTokeny(nowe, "nieistniejaca-blokada", obecne.refresh_token),
    ).resolves.toBe(false);

    const blokada = await stub.zarezerwujBlokade("broadcaster", 30_000);
    expect(blokada).toEqual(expect.any(String));
    await expect(
      stub.zapiszOdswiezoneTokeny(nowe, blokada, "nieaktualny-refresh"),
    ).resolves.toBe(false);
    await expect(stub.pobierzTokeny()).resolves.toEqual(obecne);

    await expect(
      stub.zapiszOdswiezoneTokeny(nowe, blokada, obecne.refresh_token),
    ).resolves.toBe(true);
    await expect(stub.pobierzTokeny()).resolves.toEqual(nowe);
  });

  it("niezmiennie wiąże rejestr instalacji z jednym kanałem", async () => {
    const stub = utworzStub("registry");

    await expect(stub.oznaczGlobalnyCutoverD1("123456")).resolves.toBe(true);
    await expect(stub.oznaczGlobalnyCutoverD1("123456")).resolves.toBe(true);
    await expect(stub.pobierzGlobalnyStanCutoveru()).resolves.toEqual({
      broadcaster_id: "123456",
      backend: "d1",
    });
    const blad = await runInDurableObject(stub, async (instancja) => {
      try {
        await instancja.oznaczGlobalnyCutoverD1("654321");
        return null;
      } catch (error) {
        return error.message;
      }
    });
    expect(blad).toBe("Rejestr cutoveru jest trwale przypisany do innego kanału Kick.");
  });

  it("po przerwaniu między rejestrem i latchem pozwala bezpiecznie dokończyć zapis", async () => {
    const stub = utworzStub("cutover-retry");

    await stub.oznaczGlobalnyCutoverD1("123456");
    expect(await stub.pobierzGlobalnyStanCutoveru()).toEqual({
      broadcaster_id: "123456",
      backend: "d1",
    });
    await expect(stub.pobierzStanCutoveru("123456")).resolves.toBeNull();

    await expect(stub.oznaczCutoverD1("123456")).resolves.toBe(true);
    await expect(stub.oznaczCutoverD1("123456")).resolves.toBe(true);
    await expect(stub.pobierzStanCutoveru("123456")).resolves.toBe("d1");
  });

  it("zachowuje dane SQLite po evikcji i ponownym uruchomieniu obiektu", async () => {
    const stub = utworzStub("eviction");

    await stub.oznaczGlobalnyCutoverD1("123456");
    await stub.oznaczCutoverD1("123456");
    await evictDurableObject(stub);

    await expect(stub.pobierzGlobalnyStanCutoveru()).resolves.toEqual({
      broadcaster_id: "123456",
      backend: "d1",
    });
    await expect(stub.pobierzStanCutoveru("123456")).resolves.toBe("d1");
  });

  it("izoluje latch kanału pomiędzy różnymi nazwami Durable Object", async () => {
    const pierwszy = env.OAUTH_TOKENS.getByName(`cutover-test-a-${crypto.randomUUID()}`);
    const drugi = env.OAUTH_TOKENS.getByName(`cutover-test-b-${crypto.randomUUID()}`);

    await pierwszy.oznaczCutoverD1("111111");

    await expect(pierwszy.pobierzStanCutoveru("111111")).resolves.toBe("d1");
    await expect(drugi.pobierzStanCutoveru("222222")).resolves.toBeNull();
  });
});
