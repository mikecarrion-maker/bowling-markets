# Bowling Tournament Markets

A small web app for running bid/offer score markets on each player in your bowling tournament,
with depth-based liquidity, auto-moving lines, an approval queue for big bets, and a risk view.

## How the markets work

- Each player has a market: a **bid** (e.g. 75) and an **offer** (e.g. 85), each with a **size**
  (how much can be bet at that price right now — e.g. "$10 x $10").
- **Hit the bid** ("under") = betting the player scores **below** the bid.
- **Lift the offer** ("over") = betting the player scores **above** the offer.
- Score lands **between** bid and offer → **push**, stake returned, no win/loss.
- A win pays even money (stake back, plus an equal amount).

## Liquidity, auto-move & reset

Every market has a **bid size** and an **offer size** — the most that can be matched at the
current price on that side. A "10x10 market" means $10 of size on each side.

- A bet that fits within the available size on its side fills immediately at the current price
  and reduces that side's size.
- When a side's size is fully used up, the line **automatically moves** by the **move
  increment** (toward the side that got hit — e.g. if "under" bets exhaust the bid size, both
  bid and offer move down) and **both sides reset** back to the standard size.
- You can turn auto-move off for a player; if it's off, an exhausted side just sits at $0 size
  until you manually adjust it.
- You can manually edit any player's bid, offer, and sizes at any time from the dashboard.

**Defaults & overrides:** set a global default size and move increment in Settings. Each player
can override either value, or leave it blank to use the global default.

## Bets larger than the available size → pending approval

If a bettor's stake is bigger than the size currently available on that side, the **whole bet**
is held as **pending** — it does not partially fill. It shows up in the "Pending Requests"
section of the dashboard with a notification badge. You can:

- **Accept** — locks the bet in at the *current* market price (which may have moved since the
  bettor submitted it) and consumes size as normal, possibly triggering an auto-move/reset.
- **Decline** — the bet is cancelled with no effect on the market; the bettor's stake is not
  charged.

## Managing markets

From the dashboard you can, per player:

- **Pause** betting (bettors see the market but can't place new bets) and **resume** it later.
- **Cancel** an individual open bet — refunds the stake, does not undo any market move it
  caused.
- **Void** an entire market — refunds *all* open bets on that player as "no contest" and
  declines any pending requests. Use this if a player withdraws, etc.
- **Settle** — enter the final score to grade every open bet (won/lost/push) and compute
  payouts. Any pending requests are automatically declined. **Reopen** undoes a settlement or
  void if you made a mistake.
- **Delete** a player entirely (only available once settled or voided) — removes the player and
  all associated bets.

## Exposure / risk view

The dashboard shows, per player and in total:

- **Stakes held** — total money currently at risk across open bets.
- **Under stakes** / **Over stakes** — how much is bet on each side.
- **Net if low** / **Net if high** — your rough worst-case profit or loss if every market landed
  at its lowest possible outcome (all unders win) or highest possible outcome (all overs win),
  assuming even-money payouts. Positive = you keep money; negative = you'd pay out more than
  you're holding.

This is a simplified, even-money view meant to flag lopsided markets at a glance — not an exact
simulation of every possible combination of scores.

## Admin passcode

The dashboard at `/admin` can be locked with a passcode:

- **By default, no passcode is set** — anyone with the `/admin` link can manage markets. A
  banner reminds you of this until you set one.
- To set one, go to **Settings → Admin passcode**, enter a passcode, and click **Save
  passcode**. From then on, `/admin` and all admin actions require it.
- Your browser remembers the passcode (via local storage) once you enter it, so you won't be
  asked again on the same device/browser.
- To remove the passcode (open access again), use **Remove passcode** in Settings.
- The bettor-facing page (`/`) never requires a passcode.

## Running it

Requires [Node.js](https://nodejs.org) (v18+).

```
cd bowling-markets
npm install
npm start
```

Then open:

- **Bettor view (share this):** `http://localhost:3000/`
- **Market maker dashboard:** `http://localhost:3000/admin`

Data is stored in `data/db.json` (created automatically on first run).

## Sharing the link with bettors

By default the app only listens on your computer. To let other people on the same
WiFi/network place bets from their phones:

1. Find your computer's local IP address (e.g. on Mac: System Settings → Wi-Fi → Details,
   or run `ipconfig getifaddr en0` in Terminal). It'll look like `192.168.1.42`.
2. Share `http://192.168.1.42:3000/` with bettors (make sure they're on the same network).
3. Keep `npm start` running while the tournament is on.

To make the link work from outside your network (e.g. for remote bettors), you'd need to
deploy this app to a hosting provider (Render, Railway, Fly.io, etc.) — happy to help set
that up if you want it.

## Day-of workflow

1. Before the tournament: in the admin dashboard, set your default size and move increment
   under Settings, and (optionally) set an admin passcode.
2. Add each player with their opening bid/offer (and size/increment overrides if needed).
3. Share the bettor link. People place bets themselves (name, stake) — no need to text you.
4. Markets move automatically as bets fill and sides get exhausted; override any line, size,
   or override setting manually whenever you want. Big bets land in "Pending Requests" for your
   accept/decline.
5. Keep an eye on the Exposure view to spot lopsided markets.
6. Pause a market if you need to stop betting temporarily (e.g. player is mid-frame and you want
   to hold the line); resume when ready.
7. After each player finishes, enter their **final score** and hit **Settle** — all open bets
   are graded and payouts calculated automatically. **Reopen** undoes a settlement if needed,
   and **Void** refunds everyone with no contest if a market needs to be scrapped.
8. The "My Bets" section on the bettor page lets anyone look up their own bet history, including
   pending requests and their outcome, by name.

## Notes / things you might want to tweak later

- Payouts are even-money (1:1) by default — let me know if you want different odds (e.g. odds
  that depend on how wide the bid/offer spread is).
- There's no per-user login on the bettor side — anyone with the link can place bets under any
  name. Fine for a friendly tournament; flag it if you want names locked to specific people.
- The admin passcode is a single shared code, stored in plain text in `data/db.json` — good
  enough to keep casual visitors out, not a substitute for real auth.
- All data lives in one JSON file, so it's easy to back up (just copy `data/db.json`) or
  reset (delete it and restart the server).
