# 🐷 Saustall USA PayMe

Damit am Ende klar ist, **wer wem was schuldet**. In den USA kommt meistens
**eine Rechnung** für alle – einer zahlt, der Rest trägt hier ein, was auf ihn
entfällt.

* Beträge werden in **US-Dollar** eingetragen und mit **einem festen Euro-Kurs**
  für die ganze Reise umgerechnet (überall als *kein Live-Kurs* gekennzeichnet).
* Am Ende werden alle Schulden **zusammengezählt und gegeneinander verrechnet**,
  so dass am Schluss möglichst wenige Zahlungen übrig bleiben.
* Die ganze Gruppe teilt sich **ein Konto-Buch**. Nichts wird je überschrieben
  oder gelöscht.

## Für alle in der Gruppe

1. Den Link aus der WhatsApp-Gruppe auf dem Handy öffnen.
2. Auf **🐷 App installieren → Auf dem Home-Bildschirm ablegen** tippen (oder oben
   rechts auf das **⤓**-Symbol). Falls der
   Browser nicht von selbst fragt, zeigt die App die passende Anleitung für dein
   Handy an. Danach verhält sie sich wie eine normale App.
3. Einmal den **eigenen Namen antippen**. Das ist ab dann dein Konto – du musst
   nie wieder etwas auswählen.
4. Unter **Einstellungen** den **Gruppen-Code** einfügen, der rumgeschickt wurde.
   Ohne ihn kannst du zwar alles anschauen, aber nichts eintragen.
5. Fertig. Ausgaben unter **Neu** eintragen, Stand jederzeit unter **Übersicht**.

### Eine Ausgabe eintragen

* *Wer hat bezahlt?* – der, der die Karte gezückt hat.
* *Für wen?* – die Leute antippen, um die es geht: nur dich, ein paar, oder alle.
* *Betrag in US-Dollar* – gleichmäßig geteilt, oder auf **Einzeln** umstellen und
  jedem seinen eigenen Betrag geben.
* Speichern. Das war's.

### Übersicht

* Dein eigener Stand – was du zurückbekommst oder noch schuldest.
* Der Stand von allen.
* **Wer zahlt an wen** – die kürzeste Liste an Zahlungen, mit der alles beglichen
  ist. Auf *Bezahlt* tippen, sobald das Geld wirklich geflossen ist.

Vertippt? Im **Verlauf** kannst du **stornieren**, was du selbst eingetragen hast.
Gelöscht wird nie etwas – die Stornierung wird als sichtbare Rückbuchung eingetragen.

### Ohne Internet

Du kannst **jederzeit eintragen**, auch ohne Empfang – im Restaurant, im Nationalpark,
im Flieger. Der Eintrag wird auf dem Handy gespeichert, oben steht dann *„Kein
Internet – wird automatisch hochgeladen, sobald wieder Verbindung da ist“*.

Sobald wieder Netz da ist, lädt die App **von selbst** hoch: beim Wiederverbinden,
beim Öffnen der App und sonst regelmäßig im Hintergrund. Du musst nichts drücken.
Solange noch etwas aussteht, steht die Zahl oben im Banner – und es gibt einen
Knopf *Jetzt versuchen*, falls du nicht warten willst.

### Administrator

Jan ist Administrator. Nur auf dem Handy, auf dem *Jan* ausgewählt ist, gibt es
zusätzlich:

* **Leute → Person hinzufügen**, jederzeit, auch mitten in der Reise. Wer später
  dazukommt, startet bei null und taucht nur in Ausgaben ab diesem Zeitpunkt auf.
* **Leute → umbenennen**.
* **Einstellungen → Wechselkurs** für die ganze Gruppe setzen. *Aktuellen Kurs aus
  dem Internet holen* trägt den heutigen EZB-Kurs ein; mit *Kurs für die ganze
  Gruppe setzen* wird er dann für die Reise eingefroren.
* **Verlauf → jeden Eintrag stornieren**, nicht nur die eigenen.

---

## Technical notes (English)

## Setup (once, before the trip)

### 1. Publish the app

**Settings → Pages** in this repository:

* Source: **Deploy from a branch**, branch `main`, folder `/ (root)` → **Save**

A minute later the app is live at
`https://janheitzmann0-svg.github.io/Bruno_derPanda/` — that is the link for the
WhatsApp group.

### 2. Create the group code

The app runs entirely in the browser, so uploading an entry needs a GitHub token.

**github.com → Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token**

* **Repository access:** *Only select repositories* → this repository only
* **Permissions → Repository permissions → Contents:** **Read and write**
* **Expiration:** just past the end of the trip

Copy the `github_pat_…` value — that is the *group code*. Send it into the
WhatsApp group together with the link.

It is stored in each phone's local storage only, is **never written into this
repository**, and can only touch this one repository. When the trip is over,
delete the token on GitHub and it stops working on all phones at once.

### 3. Set the rate

Open the app as Jan → **Einstellungen → Wechselkurs** → *Aktuellen Kurs aus dem
Internet holen* (ECB reference rate via frankfurter.app, with open.er-api.com as
a fallback) → *Kurs für die ganze Gruppe setzen*. The value is then frozen for
the trip; it is never refreshed on its own. Until it is set, every screen shows a
red warning that a placeholder is being used.

---

## How the shared data works

Each entry is written as its **own immutable file** under `data/entries/`:

```
data/entries/2026-09-18T19-42-11-003Z_m1k2j3abc.json
```

* Two people entering an expense at the same second write to different files, so
  there is **never a merge conflict**.
* Nothing is ever edited or removed. A mistake is corrected with an **undo
  entry** — an append-only reversal that stays visible in the history.
* Reading is a plain public read of this repo and needs no code; only writing
  does.

Entry types: `person`, `rename`, `expense`, `settle` (a repayment), `rate` (the
fixed exchange rate), `void` (an undo).

Amounts are stored in **dollars**. The euro figures are derived from the fixed
rate, so changing the rate re-displays everything — it never rewrites history.

Entries made offline are queued on the phone and uploaded on the next sync.
