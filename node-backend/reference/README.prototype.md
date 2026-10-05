# ProfitPilot demo — front-end prototype (v1.1)

The single-file demo a judge can open from a QR code: **one HTML file, no install,
no build, no network, no tracking.** It runs the whole ProfitPilot 1.0 engine in
the browser and walks a seller through pricing across a product's lifecycle.

* File: `uploads/index (2).html` — 971 lines, 208 KB, self-contained.
* Case: *Pricing across a product's lifecycle: the new-to-online seller* · Meesho
  DICE Challenge Season 3 · Business Track · Round 2.
* Team Fiery Diamonds · IIT Madras.
* Frozen copy for reference: `profitpilot-backend/reference/index.v1.1.original.html`
  (byte-identical). The backend also serves a wired copy — see
  *[Wiring it to the backend](#wiring-it-to-the-backend-optional)*.

**Every number in it is simulated or a planning default from our deck. Nothing is
real Meesho data.** Pilot figures are targets with causal chains, not results.
The About screen says this too, on purpose.

## Open it

| | |
|---|---|
| Desktop | double-click the file, or drag it into any browser |
| Phone | email / AirDrop / WhatsApp it, or scan a QR to it — it opens as a normal page |
| Offline | fully works: no CDN, no fonts to fetch, no API. The only URL in the file is the SVG namespace |
| Theme | follows the OS (light/dark); the About screen has a 🌓 toggle |
| Reset | About → *Reset demo* (or just reload — state lives in memory) |
| Persists | only the language choice (`localStorage`, key `pp_lang`). Everything else is per-session |

## What's on screen

Eleven screens, reachable from the drawer (☰); four of them also sit in the bottom
nav, and every screen carries the deck section it comes from.

| Screen | What it shows | What to try |
|---|---|---|
| 🏠 **Home** | today's suggestions for all five SKUs, health chips, pending count, control modes | tap **YES / NO / WHY** on a card — an accepted move changes the price on every screen and starts a 7-day cooldown |
| 🏷️ **First price** | the 8-step cold-start wizard: costs → floor **F** → `P*` per mode → dual price | edit a cost on step 2 and watch the floor, the start price and the dual menu recompute instantly |
| 🎯 **Modes** | CASH · GROWTH · MARGIN · CLEAR: the lead price each mode chooses and why | switch mode in the top bar; the Home cards, Lifecycle, Engine lab and Coach all change |
| 🎚️ **Simulator** | drag the price → orders/day, profit/day, kept orders, RTO mix | drag **below the floor** to trigger the Loss Warning and the ₹ lost per kept order |
| 🩺 **Diagnose** | the 8-node scan that runs *before* any discount: visibility → CTR → CVR → returns/RTO → cost, **price last** | run the scan, open a node's *Why*, then read the recommended fix (a photo, not a discount) |
| 📈 **Lifecycle** | the five stages with per-category windows, the trigger timeline, the rival hold-vs-match test, the markdown ladder, the six exits | drag the day slider through Launch → Growth → Maturity → Decline → Exit |
| 🧭 **Coach** | chips + free text in Hindi and English, cards with YES/NO, every answer carrying a source | ask *"Returns kyun aa rahe hain?"*, *"My orders dropped"*, *"Should I run ads?"* |
| ⚙️ **Engine lab** | the constrained Thompson bandit running live: arms, posteriors, hidden "truth", holdout, fairness | press **▶ 1 day** / **⏩ 30 days**, then read the arms table — the ₹299 arm never gets a single pull |
| 🧪 **Pilot** | sample size (n ≈ 251), the city scores, the impact waterfalls, the cohort maths, the stop rules | check Surat 4.55 vs Rajkot 4.10 and the backup city |
| 🚀 **ProfitPilot 2.0** | the four programmes and the opt-in modules (reorder point, pooling, packaging audit, coach) | see *ROP = 84 + 18 = 102 units* and why it is off by default |
| ℹ️ **About** | what the demo is, the one hard rule, the team, theme + reset | the footer: *"ProfitPilot demo v1.1 · built for judges scanning a QR on a phone"* |

**Shell:** top bar = product picker, goal mode, floor pill (`🛡️ F ₹309` opens the
floor *Why*), and the control-mode pill (Manual / Co-Pilot / Autopilot). Bottom nav
= Home, First price, Simulator, Lifecycle, More. Floating 🧭 button opens the Coach.
`Esc` closes any sheet.

## A five-minute demo script

1. **Home** — "This is Ramesh's catalogue. 89 orders a day, ₹83 profit per *kept*
   order. Only three of these need a decision today." Tap **Why?** on the kurti
   card: what · why (with signals) · ₹ effect · confidence · undo.
2. Tap **YES** — "the price moved ₹369 → ₹384, it is now in cooldown for 7 days,
   and the audit shows who decided." Open *More → Backend* if the API is wired.
3. **First price** — change sourcing ₹180 → ₹220: "the floor moves ₹309 → ₹349, the
   start price moves with it, and the dual-price menu follows. The seller never
   types the return cost; we compute it."
4. **Simulator** — drag to ₹249: "this is the Loss Warning: −₹60 on every kept
   order. We say it out loud instead of hiding it in an average."
5. **Diagnose** — run the scan: "views are fine, clicks are broken (CTR 2.5% vs
   4.0%). The fix is the main photo, not a discount. Price is checked **last**."
6. **Lifecycle** — drag to day 56: "the rival lists at ₹499; holding earns more
   than matching. At day 140 the markdown ladder starts, and it never crosses F."
7. **Engine lab** — press ⏩ 30 days: "traffic drifts to ₹369; ₹299 is blocked for
   being below the floor; 5% of impressions go to the holdout so we can prove the
   lift instead of asserting it."
8. **Coach** — ask in Hindi: "same answers, same sources, and it never changes a
   price by itself — only your tap does."

## The engine inside the file

All of it is plain JavaScript in the same file, and every constant is the one from
the deck.

| Piece | Where | What it does |
|---|---|---|
| Category priors | line ~206 | return/RTO/unit-cost priors per category (used until the seller has own history) |
| SKU library | ~214 | five SKUs with price, costs, band, median, life, signals (`sig`), recovery floor |
| Floor `FL()` | ~244 | `100 → 97 dispatched → −RTO → delivered → −returns → kept`, `F = ΣC ÷ kept`, `P_easy = F + T`, `P_no = F − C_ret + T`, arms, `F⁺`, `Pm` |
| Demand | ~260 | `ln q = α + β ln p` with `β = −3` and a look-alike penalty above the median (`γ = 120`); `profit/day = orders × k × (p − F)` |
| Trigger hygiene | ~268 | the six pre-flight checks: floor, ±8% step, 1,000 views, 7-day cooldown, ≤2 moves/month, 14/28-day revert |
| `recFor()` | ~289 | the weekly card: mode-aware (`cash/growth/margin/clear`), freshness, stock, kept-rate and band logic, plus `preflight`, `logic` (the ✔/✘ tree) and the five Why blocks |
| Diagnose | ~613 | the 8-node scan, ₹ at risk per node, the price-value branch, the Panic Brake |
| Lifecycle | ~653 | stage windows scaled by category life, the day slider, the rival test, `M1/M2/M3` markdown ladder, six exits with recovery % |
| Engine lab | ~807 | constrained Thompson sampling: one draw per day, one menu live for all buyers, 95 treatment + 5 holdout impressions, fairness, expected vs observed lift |
| Pilot | ~877 | `n = 2 × (1.96 + 0.84)² × 40² ÷ 10² = 250.88 → 251`, city scores, waterfalls, cohort |
| Coach | ~753 | intent routing + cards + Why sheets, Hindi/English |
| 2.0 preview | ~916 | programmes, ROP, pooling, packaging audit |

**The kurti, end to end** (the deck's own worked example): `100 → 97 → 8 RTO → 89
→ 11 returned → 78 kept`, `k = 0.78`; `F = 180 + 10 + 25 + 32 + 18 + 44 = ₹309`;
`B = ₹50`; `P_easy ₹369`, `P_no ₹339`, gap `₹30`; arms `₹299 / 339 / 369 / 399 /
429`; `F⁺ ₹319`, `Pm ₹399`; the Growth card reads `₹369 → ₹384` (+₹15 per kept
order).

**Every suggestion carries its five Why blocks** — *what · why (signals with
numbers) · ₹ effect · confidence (with its reason) · undo / auto-revert* — and the
engine trees are labelled *"engine logic · the seller only sees ✔ / ✘"*. That is
the one hard rule of the demo: a seller is never asked to interpret a model.

## File map

```
lines 1–7      head, meta, data-URI favicon (no external assets)
lines 8–190    <style> — all CSS, light + dark, mobile-first, no frameworks
line 190       the app shell: .top · #ctx · #view · #nav · #fab · #ov
line 191–971   one <script> — the entire app
  193  shared state (S), data, engine
  214  SKU library                 215  category priors
  244  floor F                     260  demand model
  268  pre-flight                  289  recommendation engine
  339  Why sheet                   355  overlays            361  router + shell
  400  Home                        450  First price (8 steps)
  538  Modes                       558  Simulator
  613  Diagnose                    653  Lifecycle
  753  Coach                       807  Engine lab
  877  Pilot                       916  ProfitPilot 2.0     954  About
  965  boot
```

Extract the script on its own (for linting or diffing):

```bash
awk 'NR>=191' "uploads/index (2).html" | sed 's|</script></body></html>||' > /tmp/app.js
```

## Where to change things

| Want to change | Edit |
|---|---|
| a SKU's price, costs, band, signals | the `SK` object, line ~215 (`sig` holds views, CTR, CVR, DOI, rival gap, stage) |
| category return/RTO priors and unit costs | `CAT`, line ~207 |
| the state shape (selected SKU, mode, decisions, control) | `S`, line ~194 |
| guardrail numbers (8%, 7 days, 2/month, 1,000 views) | `HYG`, line ~269 and `preflight()`, line ~276 |
| demand elasticity or the look-alike penalty | `BETA`, `GAMMA`, `pen()`, line ~228 / 261 |
| goal-mode rules | `MODES`, line ~230 and `modePrice()`, line ~254 |
| a screen's layout | the matching `VIEWS.<name>` block (see the file map) |
| any string, in both languages | it is inline: `t('English', 'हिंदी')` |

**Bilingual by design:** there is no translation file. Every user-facing string is
written as `t('English', 'Hindi')` at the point of use, so a missing translation is
visible in the code, not in a bundle. `t()` falls back to English when the second
argument is missing. The language choice persists in `localStorage`.

## Wiring it to the backend (optional)

The prototype runs standalone. To let a server compute the numbers instead, add one
line before `</body>`:

```html
<script src="api-bridge.js"></script>
```

That is exactly what `profitpilot-backend/public/index.html` does. The bridge
(756 lines, in the backend repo) converts server payloads into the shapes this file
already uses (`FL`, `recFor`, `lcModel`, `EN`, `CARDS`), adds a **🟢 Engine server**
badge and a **Backend** screen, and — importantly — **keeps this file's engine as
the fallback**: if the server is unreachable, every screen still works offline and
the badge goes grey. Nothing in this file has to change.

The two engines are held together by a test, not by hope:
`profitpilot-backend/test/parity.test.js` extracts the engine out of this file, runs
it in isolation, and compares it field by field with the backend — floors,
sensitivity levers, demand across prices, mode prices, the six pre-flight checks
(labels, flags *and* text) and the weekly card, for all five SKUs in all four modes.

## Honest limits

* **Simulated data.** Five illustrative SKUs, category priors, planning defaults.
  The "hidden truth" in the Engine lab is a made-up demand curve: that is the point
  of a bandit demo, and it is labelled as such on the screen.
* **The holdout is small here.** The prototype simulates 5 holdout impressions per
  day (95 treatment + 5), so after 30 days the observed lift is noisy. The pilot
  design on slide 8 is a **permanent 5% holdout**; the backend uses that, and its
  confidence interval still spans zero after 30 days — which is the honest answer
  for one listing.
* **The Coach is rule-based**, not an LLM: intents, cards and answers are written in
  the file, with sources. The 🎤 button is a **stub** — it shows "Listening…", then
  asks a canned question. No speech API, no audio leaves the phone.
* **All state is in memory** (only the language persists). Reload = fresh demo.
  That is deliberate for a pitch: no half-finished states in front of judges.
* **It prices, it does not control costs.** Sourcing, packaging and freight changes
  are the 2.0 programmes and need the seller's opt-in — the modules exist on the
  2.0 screen, off by default.
* **Not a real product UI.** Meesho's real supplier panel, auth and catalogue are
  out of scope; this is the decision layer, demonstrated.

## Provenance

Every screen names its deck section (shown in the drawer subtitle): Economics (2),
Launch (3), Lifecycle (4), Diagnose (5), Solution (6), Engine (7), Pilot & impact
(8), Limits & risks (9), ProfitPilot 2.0 (10).

For the full claim-by-claim map — including the two places where the deck's printed
figures are rounding of the engine's own arithmetic — see
`profitpilot-backend/docs/DECK_FIDELITY.md`. For the API the wired copy talks to,
see `profitpilot-backend/docs/API.md`.
