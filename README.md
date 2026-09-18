# Trip Split

A small installable web app (PWA) for a group that keeps getting **one bill** for
everybody — typical in US restaurants — and needs to know at the end **who owes
whom**.

* One person pays the whole bill, everyone picks what they owe.
* Amounts are entered in **US dollars** and converted with **one fixed euro rate**
  for the whole trip (clearly marked as *not live*).
* At the end all debts are added up and **cancelled out against each other**, so
  the app shows the smallest possible set of payments.
* The whole group shares **one ledger**, stored as plain JSON files in this
  repository. Nothing is ever overwritten or deleted.

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
* Reading the ledger is a plain public read of this repo. Writing needs a token
  (see below).

Entry types: `person`, `expense`, `settle` (a repayment), `rate` (the fixed
exchange rate), `void` (an undo).

---

## Setup (about 5 minutes, once)

### 1. Publish the app

**Settings → Pages** in this repository:

* Source: **Deploy from a branch**
* Branch: `main`, folder `/ (root)` → **Save**

After a minute the app is live at
`https://<your-user>.github.io/<repo>/`.
Open it on a phone and use *Add to home screen* — it then behaves like a normal
app and also works offline.

### 2. Create the write token

The app runs entirely in the browser, so uploading an entry needs a GitHub token.

**github.com → Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token**

* **Repository access:** *Only select repositories* → this repository only
* **Permissions → Repository permissions → Contents:** **Read and write**
* **Expiration:** just past the end of the trip

Generate it and copy the `github_pat_…` value.

### 3. Share it with the group

Send the token to the group over a private channel (WhatsApp group, etc.).
Everyone opens the app → **Settings** → pastes the token → **Save & sync now**.

The token is kept in that phone's local storage only. It is **never written into
the repository**, and it can only touch this one repository. When the trip is
over, delete the token on GitHub and it stops working everywhere at once.

### 4. First run

1. **People** → *Add many at once* → paste the list of names, one per line.
2. Everyone taps their own name (*That's me*) on their phone.
3. **Settings → Exchange rate** → set the euro-per-dollar rate once for the trip.

---

## Daily use

**Add** tab:

* *Who paid the bill?* — the person who handed over the card.
* *Who is it for?* — tap the people it covers (yourself only, a few, or everyone).
* *Amount in US dollars* — split equally, or switch to **Custom** to give each
  person their own amount.
* Save.

**Balance** tab:

* Your own total — what you get back, or what you still owe.
* Every person's net balance.
* **Who pays whom** — the minimal list of payments that settles the whole group.
  Tap *Settle* once a payment has actually been made.

**History** tab: every entry, with *Undo* for mistakes.

---

## Notes

* Amounts are stored in **dollars**. The euro figures are derived from the fixed
  rate, so changing the rate re-displays everything — it never rewrites history.
* Works offline: entries are saved on the phone and uploaded on the next sync.
* Roughly one GitHub commit per entry. A 10-day trip for 20 people is a few
  hundred small files — well within anything GitHub cares about.
