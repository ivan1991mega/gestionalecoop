# Magazzino Uniformi

Gestionale web per magazzino e cassa, con database Postgres e storico dei movimenti.
Funziona da computer, telefono e tablet. Accesso protetto da login.

**Accesso predefinito:** utente `admin` · password `admin`
(puoi cambiarli — vedi "Cambiare la password" piu sotto)

---

## Cosa fa

- **Magazzino** - elenco articoli, valore totale a prezzo di vendita, incasso di oggi
- **Cassa** - selezioni gli articoli, applichi sconto e contanti, vedi l'anteprima dello scontrino e lo stampi (termica 58mm)
- **Modifica** - cambi descrizioni, prezzi, categorie e giacenze
- **Import Danea** - carichi l'export Excel: aggiorna i prodotti esistenti e crea i nuovi
- **Storico** - ogni movimento tracciato: vendite, import, carichi, rettifiche

---

# Guida rapida: metterlo online in ~10 minuti

Ti servono due account gratuiti: **GitHub** (per il codice) e **Railway** (per farlo girare).
Non serve installare niente sul tuo computer.

### Passo 1 - Crea l'account GitHub e carica il progetto

1. Vai su https://github.com e registrati (se non hai gia un account).
2. In alto a destra clicca **+ -> New repository**.
3. Dai un nome, es. `magazzino-uniformi`, lascia tutto com'e e clicca **Create repository**.
4. Nella pagina che si apre clicca **uploading an existing file**.
5. **Scompatta lo zip** che hai ricevuto e trascina tutto il contenuto della cartella
   (i file e le sottocartelle `server` e `public`) nella pagina di GitHub.
6. In basso clicca **Commit changes**.

### Passo 2 - Pubblica su Railway

1. Vai su https://railway.app e clicca **Login -> Login with GitHub**.
2. Clicca **New Project -> Deploy from GitHub repo** e scegli `magazzino-uniformi`.
   Railway inizia a costruire l'app da solo.
3. Aggiungi il database: dentro il progetto clicca **+ New -> Database -> Add PostgreSQL**.
   Railway lo collega automaticamente all'app.
4. Rendi l'app raggiungibile: clicca sul riquadro dell'app -> scheda **Settings** ->
   sezione **Networking** -> **Generate Domain**.
   Ottieni un indirizzo tipo `https://magazzino-uniformi.up.railway.app`.

### Passo 3 - Entra e carica il magazzino

1. Apri quell'indirizzo nel browser.
2. Fai il login con **admin / admin**.
3. Vai su **Import Danea**, tieni selezionato **"Allinea giacenze"** e carica `Prodotti.xlsx`.
4. Fatto: trovi tutti gli articoli in Magazzino e sei pronto a vendere in Cassa.

> Il database si crea da solo al primo avvio, non devi fare niente a mano.

---

## Usarlo dal telefono o tablet

E un sito: apri lo stesso indirizzo dal browser del telefono e fai il login.
Per averlo come un'app con l'icona in home:
- **iPhone/iPad (Safari):** tocca Condividi -> Aggiungi a Home
- **Android (Chrome):** menu con i tre puntini -> Aggiungi a schermata Home

---

## Cambiare la password

Di default l'accesso e admin / admin. Per cambiarlo:

1. Su Railway apri il riquadro dell'app -> scheda **Variables**.
2. Clicca **+ New Variable** e aggiungi:
   - `AUTH_USER` -> il nome utente che vuoi
   - `AUTH_PASS` -> la password che vuoi
   - `AUTH_SECRET` -> una stringa lunga a caso: tiene validi gli accessi dopo un riavvio.
3. Salva: l'app si riavvia da sola con le nuove credenziali.

> Se non imposti `AUTH_SECRET`, tutto funziona lo stesso, ma a ogni riavvio dell'app
> dovrai rifare il login.

---

## Usare l'import ogni volta

- **Allinea giacenze** - la giacenza diventa quella del file. E la "foto" del magazzino da Danea:
  usala per il primo caricamento e per riallineare tutto.
- **Somma come carico** - le quantita del file si aggiungono a quelle attuali:
  usala quando arriva merce nuova.

I prodotti vengono riconosciuti per **codice**, quindi puoi rifare l'export da Danea
quante volte vuoi: aggiorna quelli giusti senza creare doppioni.

---

## Stampare lo scontrino (stampante termica 58mm)

Lo scontrino e gia formattato per i rotoli termici da **58mm** (larghezza di stampa reale ~48mm):
font a spaziatura fissa, descrizioni che vanno a capo, prezzi allineati a destra.

Quando premi **Incassa & stampa** compare prima l'anteprima dello scontrino a schermo (una "carta" da 58mm identica alla stampa). Da li premi **Stampa** per aprire la finestra di stampa del browser, oppure **Chiudi** se non serve stamparlo. Puoi rivedere l'ultimo scontrino con **Rivedi ultimo scontrino**.
La **prima volta** imposta cosi (poi il browser ricorda):

- **Destinazione / stampante:** scegli la tua stampante termica.
- **Formato carta:** 58mm (se non c'e in elenco, cerca "Roll 58mm" nelle proprieta del driver della stampante).
- **Margini:** Nessuno.
- **Scala:** 100% (o "Predefinita"). Disattiva "adatta alla pagina".
- Togli intestazioni e pie di pagina del browser, se presenti.

Suggerimenti:
- Su Windows installa il driver della stampante e impostala come predefinita: la stampa parte piu liscia.
- Da telefono/tablet la stampa termica funziona meglio se la stampante e collegata via app del produttore o via stampa di sistema (AirPrint / Mopria).
- Se lo scontrino esce troppo stretto o tagliato, e quasi sempre la voce **Margini: Nessuno** o la **Scala** da sistemare.

---

## Dettagli tecnici (facoltativi)

- Il **valore di magazzino** e calcolato sul **prezzo di vendita** (il file Danea non ha il costo).
- Le **categorie** usano solo il primo livello (es. `Distintivi » Bracciale` -> "Distintivi").
- Lo scontrino e **non fiscale** (promemoria interno).
- Eliminare un prodotto lo **archivia**: sparisce dagli elenchi ma resta nello storico.

### Sviluppo in locale (solo se ti serve)
Richiede Node.js e un Postgres locale.
```
cp .env.example .env
npm install
npm start
```

### Backup
I dati stanno nel Postgres di Railway. Per un backup manuale usa
Postgres -> Connect su Railway con pg_dump.
