# 🐷 Saustall USA PayMe

An installable web app (PWA) for a group that keeps getting **one bill** for
everybody — as is usual in the US — and needs to know at the end **who owes whom**.

* One person pays the whole bill, everyone picks what they owe.
* Amounts are entered in **US dollars** and converted with **one fixed euro rate**
  for the whole trip (marked everywhere as *not live*).
* At the end all debts are added up and **cancelled out against each other**, so
  the app shows the smallest possible set of payments.
* The whole group shares **one ledger**, stored as plain JSON files in this
  repository. Nothing is ever overwritten or deleted.

---

## For everyone in the group

1. Open the link from the WhatsApp group on your phone.
2. **iPhone:** Share → *Add to Home Screen*. **Android:** menu → *Install app*.
   It then behaves like a normal app and also works offline.
3. Open it and **tap your own name** once. That is your account from then on —
   you never need to choose again.
4. Go to **Settings** and paste the **group code** that was sent round.
   Without it you can look, but not add anything.
5. Done. Log expenses on the **Add** tab, check the **Balance** tab any time.

### Logging an expense

* *Who paid the bill?* — the person who handed over the card.
* *Who is it for?* — tap the people it covers: only yourself, a few, or everyone.
* *Amount in US dollars* — split equally, or switch to **Custom** to give each
  person their own amount.
* Save. That's it.

### The Balance tab

* Your own total — what you get back, or what you still owe.
* Every person's net balance.
* **Who pays whom** — the minimal list of payments that settles the whole group.
  Tap *Settle* once a payment has actually been made.

Mistakes: in **History** you can **Undo** anything you entered yourself. Nothing
is ever deleted — the undo is recorded as a visible reversal.

---

## Administrator

Jan is the administrator. On the phone where *Jan* is the chosen account, and
only there, extra controls appear:

* **People → add a person** at any time, also mid-trip. Somebody added later
  starts at zero and only shows up in expenses logged from then on.
* **People → rename** anyone.
* **Settings → exchange rate** for the whole group.
* **History → undo any entry**, not just your own.

The administrator is set in `app.js`, in `DEFAULTS.admin` (currently `p_jan`).

---

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

Open the app as Jan → **Settings → Exchange rate** → enter the euro-per-dollar
rate you want to use for the whole trip. Until that is done, every screen shows
a red warning that a placeholder is being used.

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
