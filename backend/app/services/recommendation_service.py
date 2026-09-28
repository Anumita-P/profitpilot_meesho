"""Verdict + recommendation (SPEC 15.3, 17, 18, 19).

Owns the four verdicts, the ranked intervention search, the five answer fields
(WHAT / WHY / EXPECTED IMPACT / RISK / WHAT WOULD CHANGE THIS) and the shortfall logic.
"""
from __future__ import annotations

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..database.models import Sku
from ..ml.economics import effective_sku
from ..optimization import catalogue as C
from ..optimization import search as S
from ..optimization import sensitivity as SENS
from ..optimization.comparables import confidence_label
from .runtime import bundle, comparables, ece_worst, hash_key, iv_hash, sku_dict

VERDICT_TITLES = {
    "PRICE_WORKS": "A price change can reach your goal",
    "PRICE_INFEASIBLE": "No price in the current market corridor meets your target.",
    "NEEDS_EVIDENCE": "Not enough evidence to recommend a price confidently",
    "NOT_A_PRICE_PROBLEM": "Price is probably not your main problem",
}
BANNER_INFEASIBLE = "ProfitPilot found {n} other ways to improve the economics."
GUARDRAILS = dict(recommendation_only=True, max_price_move=0.12, buyer_level_pricing=False,
                  corridor="market corridor is enforced", floor="never below your contribution floor",
                  confidence="Low-confidence advice is never recommended")


# ------------------------------------------------------------------------------------------------
def _evidence(sku: dict, price: float) -> dict:
    cmp = comparables()
    n = cmp.n_comparable(sku["category"], price)
    return dict(n_comparable=n, n_eff=float(cmp.n_eff(sku["category"], np.asarray([price]))[0]),
                category=sku["category"], price=float(price), min_required=30)


def _confidence_at(sku: dict, price: float, width: float) -> dict:
    cmp = comparables()
    n_eff = float(cmp.n_eff(sku["category"], np.asarray([price]))[0])
    gap = float(cmp.extrapolation_pct(sku["category"], np.asarray([price]))[0])
    label = str(confidence_label(n_eff=n_eff, gap=gap, width=width, ece=ece_worst())[0])
    return dict(label=label, n_eff=n_eff, extrapolation_pct=gap, band_width=width)


def price_only_search(sku: dict, goal: dict, mode: str) -> dict:
    """Two views of the same grid: `reach` ignores the per-step guardrail (can the goal be reached
    at all?), `best` respects it (what can today's move be?)."""
    prices = S.in_corridor_grid((sku["corridor_low"], sku["corridor_high"]))
    ev = S.evaluate_candidate(bundle(), sku, None, prices, goal=goal, mode=mode,
                              cmp=comparables(), ece=ece_worst())
    return dict(evaluated=ev, best=S.best_feasible(ev), reach=S.best_feasible(ev, anywhere=True),
                best_any=S.best_by_objective(ev), prices=prices)


def what_would_change(sku: dict, price: float, goal: dict) -> str:
    """Bisection on a return-rate offset (SPEC 19): at what added return rate does this break?"""
    target = float(goal.get("target_contribution", 60.0))
    mb = bundle()
    lo, hi = -0.03, 0.20
    if float(np.median(mb.block(sku, np.asarray([price]))["per_kept"][0])) < target:
        return (f"If return+RTO costs rise further, ₹{price:,.0f} falls below your ₹{target:,.0f} floor. "
                f"The recommendation is already at the floor today.")
    for _ in range(28):
        mid = (lo + hi) / 2
        pk = float(np.median(mb.block(sku, np.asarray([price]), probe=dict(ret_logit_delta=mid))["per_kept"][0]))
        if pk >= target:
            lo = mid
        else:
            hi = mid
    delta = (lo + hi) / 2
    base_leak = float(np.median(mb.block(sku, np.asarray([price]))["leakage"][0]))
    extra_leak = base_leak + max(0.0, delta * 0.05)
    return (f"If the return+RTO offset worsens by ≈{max(delta, 0)*100:.0f}% of its log-odds "
            f"(return+RTO around {extra_leak*100:.0f}% instead of {base_leak*100:.0f}%), ₹{price:,.0f} falls "
            f"below your ₹{target:,.0f} floor.")


# ------------------------------------------------------------------------------------------------
def _intervention_candidates(sku: dict, goal: dict) -> list[dict]:
    out: list[dict] = []
    available = []
    for iv in C.BASE_INTERVENTIONS:
        ok, reason = iv.applies_when(sku, goal)
        if ok:
            available.append(iv)
        else:
            out.append(dict(id=iv.id, label=iv.label, iv=iv.iv, applicable=False, reason=reason))
    for iv in available:
        out.append(dict(id=iv.id, label=iv.label, iv=iv.iv, applicable=True, one_time=iv.one_time_cost,
                        amortise=iv.amortise_days, confidence=iv.confidence, tradeoff_note=iv.tradeoff_note,
                        why_template=iv.why_template, source=iv))
    for lvl in C.PREPAID_LEVELS:
        out.append(dict(id=f"PREPAID_INC_{int(lvl)}", label=f"Prepaid incentive ₹{int(lvl)}",
                        iv=dict(prepaid_inc=float(lvl)), applicable=True, confidence="Medium",
                        tradeoff_note=f"Seller funds ₹{int(lvl)} on every prepaid order",
                        why_template="A prepaid nudge moves orders away from COD, which cuts RTO."))
    combinable = [c for c in out if c.get("applicable") and c.get("id") in C.COMBINABLE]
    for a, b in SENS.pairs(combinable):
        cross = ((a["id"] in C.COST_LEVERS and b["id"] in C.DEMAND_LEVERS)
                 or (a["id"] in C.DEMAND_LEVERS and b["id"] in C.COST_LEVERS))
        if not cross:
            continue
        out.append(dict(id=f"{a['id']}+{b['id']}", label=f"{a['label']} + {b['label']}",
                        iv=C.merge_iv(a["iv"], b["iv"]), applicable=True, confidence="Medium",
                        one_time=(a.get("one_time", 0) + b.get("one_time", 0)),
                        amortise=30, parents=[a["id"], b["id"]],
                        tradeoff_note=f"{a['label']} and {b['label']} together"))
    if float(sku["image_quality"]) < 0.40:
        out.append(dict(id="LISTING_IMAGE_SEVERE", label=C.LISTING_IMAGE_SEVERE.label,
                        iv=C.LISTING_IMAGE_SEVERE.iv, applicable=True, confidence="Medium",
                        one_time=1500.0, amortise=30,
                        tradeoff_note="₹1,500 one-time creative cost, amortised over 30 days",
                        why_template=C.LISTING_IMAGE_SEVERE.why_template))
    for lvl, factor in [(None, f) for f in C.BUNDLE_FACTORS]:
        if factor == 1.0:
            continue
        out.append(dict(id=f"BUNDLE2@{int(factor*100)}", label=f"Bundle of 2 at {int(factor*100)}% of 2× unit price",
                        iv=dict(bundle=2, bundle_ship_mult=1.35, demand_mult=0.72,
                                bundle_price_factor=factor), applicable=True, confidence="Low",
                        tradeoff_note="Larger discount inside the bundle"))
    return out


def price_only_card(sku, goal, mode, best, current, ladder: dict | None = None) -> dict:
    """A recommendation card for a pure price change using the five answers (SPEC 19)."""
    p0, p1 = float(sku["price"]), float(best["price"])
    m, base = best["metrics"], current["metrics"]
    d_orders = (m["orders_day"]["p50"] - base["orders_day"]["p50"]) / max(base["orders_day"]["p50"], 1e-9)
    d_kept = m["per_kept"]["p50"] - base["per_kept"]["p50"]
    d_leak = (m["leakage"]["p50"] - base["leakage"]["p50"]) * 100
    d_contrib = m["contribution_day"]["p50"] - base["contribution_day"]["p50"]
    direction = "Increase" if p1 > p0 else ("Reduce" if p1 < p0 else "Hold")
    what = f"{direction} price from ₹{p0:,.0f} → ₹{p1:,.0f}." if abs(p1 - p0) >= 1 else f"Keep the price at ₹{p0:,.0f}."
    why = (f"{abs(d_orders)*100:.0f}% {'fewer' if d_orders < 0 else 'more'} orders but "
           f"{'+' if d_kept >= 0 else '−'}₹{abs(d_kept):,.0f} per kept order and "
           f"{abs(d_leak):.1f}pp {'lower' if d_leak <= 0 else 'higher'} return/RTO cost, so "
           f"contribution/day moves {'+' if d_contrib >= 0 else '−'}₹{abs(d_contrib):,.0f}.")
    impact = (f"{'+' if d_contrib >= 0 else '−'}₹{abs(d_contrib):,.0f}/day retained contribution; "
              f"orders {base['orders_day']['p50']:.1f}→{m['orders_day']['p50']:.1f}/day, "
              f"₹{m['per_kept']['p50']:,.0f} per kept order.")
    conf = best["confidence"]
    risk = (f"{conf} confidence: {best['n_eff']:,.0f} weighted comparable SKU-days near ₹{p1:,.0f}"
            + (f"; {best['extrapolation_pct']*100:.0f}% outside the observed price range" if best["extrapolation_pct"] > 0 else "")
            + ".")
    next_step = None
    if ladder:
        what = (f"Step {ladder['step']} of {ladder['steps']}: {direction.lower()} price from "
                f"₹{p0:,.0f} → ₹{p1:,.0f} (target ₹{ladder['target_price']:,.0f}).")
        next_step = (f"This is one guarded step. At ₹{p1:,.0f} you are on track for the "
                     f"₹{ladder['target_price']:,.0f} goal price — re-run to take step "
                     f"{ladder['step'] + 1} once this one is live.")
    return dict(what=what, why=why, expected_impact=impact, risk=risk,
                what_would_change_this=what_would_change(sku, p1, goal), next_step=next_step)


def intervention_card(sku, goal, mode, cand: dict, ev: dict, current: dict, status: str, short: dict,
                      chosen) -> dict:
    m = chosen["metrics"]
    iv = cand["iv"]
    label = cand["label"]
    price = chosen["price"]
    if iv.get("bundle"):
        bundle_price = price * 2 * float(iv.get("bundle_price_factor", 1.0))
        what = f"Bundle 2 units at ₹{bundle_price:,.0f}" + (
            " with upgraded packaging." if iv.get("pack_delta") else ".")
        if iv.get("pack_delta") and "pack_delta" in (cand.get("iv") or {}):
            what = f"Bundle 2 units at ₹{bundle_price:,.0f}; keep the unit price at ₹{price:,.0f} equivalent, with upgraded packaging."
    elif iv.get("img_delta"):
        what = f"Improve the primary image at ₹{price:,.0f}."
    elif iv.get("fwd_delta"):
        what = f"Move this SKU onto a lighter, right-sized parcel at ₹{price:,.0f}."
    elif iv.get("pack_delta"):
        what = f"Upgrade the protective packaging at ₹{price:,.0f}."
    elif iv.get("prepaid_inc"):
        what = f"Offer a ₹{int(iv['prepaid_inc'])} prepaid incentive at ₹{price:,.0f}."
    else:
        what = f"{label} at ₹{price:,.0f}."
    d_contrib = m["contribution_day"]["p50"] - current["metrics"]["contribution_day"]["p50"]
    d_leak = (m["leakage"]["p50"] - current["metrics"]["leakage"]["p50"]) * 100
    parts = [f"contribution per kept order ₹{current['metrics']['per_kept']['p50']:,.0f}→₹{m['per_kept']['p50']:,.0f}"]
    parts.append(f"return+RTO {abs(d_leak):.1f}pp {'lower' if d_leak <= 0 else 'higher'}")
    parts.append(f"orders/day {current['metrics']['orders_day']['p50']:.1f}→{m['orders_day']['p50']:.1f}")
    why = f"{label} works because " + ", ".join(parts) + "."
    impact = (f"{'+' if d_contrib >= 0 else '−'}₹{abs(d_contrib):,.0f}/day retained contribution "
              f"(range ₹{m['contribution_day']['p10']:,.0f}–₹{m['contribution_day']['p90']:,.0f}); "
              f"₹{m['per_kept']['p50']:,.0f} per kept order.")
    risk = (f"{chosen['confidence']} confidence"
            + (f"; {chosen['n_eff']:,.0f} weighted comparable SKU-days" if chosen["n_eff"] else "")
            + (f"; one-time ₹{cand.get('one_time', 0):,.0f} cost amortised over {cand.get('amortise', 30)} days"
               if cand.get("one_time") else "")
            + (f"; {cand['tradeoff_note']}" if cand.get("tradeoff_note") else "") + ".")
    return dict(what=what, why=why,
                expected_impact=impact, risk=risk,
                what_would_change_this=what_would_change(sku, price, goal) if not iv.get("bundle") else
                f"If bundle demand were below {float(iv.get('demand_mult', 0.72))*100:.0f}% of single-unit demand, "
                f"this stops being your best option.")


def _rank_key(c: dict) -> tuple:
    order = {"FEASIBLE": 0, "NEAR_MISS": 1, "VIOLATES": 2}
    return (order.get(c["status"], 3), -c.get("objective", 0.0))


def recommend(session: Session, seller_id: str, sku_id: str, goal: dict, mode: str | None = None,
              include_interventions: bool = True) -> dict:
    row = session.scalar(select(Sku).where(Sku.sku_id == sku_id, Sku.seller_id == seller_id))
    if row is None:
        return {}
    sku = sku_dict(row)
    mode = mode or goal.get("mode", "margin")
    goal["mode"] = mode
    mb = bundle()

    current = S.pick(S.evaluate_candidate(mb, sku, None, np.asarray([float(sku["price"])]), goal=goal,
                                          mode=mode, cmp=comparables(), ece=ece_worst(),
                                          restrict_to_move_cap=False), 0)
    po = price_only_search(sku, goal, mode)
    ev, best, reach = po["evaluated"], po["best"], po["reach"]
    ladder = None
    if reach is not None and best is None:
        # the goal is reachable, just not in a single guarded step (SPEC: 12% max move per step)
        best, ladder = S.step_towards(ev, reach["price"], float(sku["price"]))
    short = S.shortfall_against(ev, goal=goal)
    evidence = _evidence(sku, float(sku["price"]))

    # --- verdict (SPEC 15.3) ---------------------------------------------------------------------
    conf_best = None
    if best is not None:
        conf_best = _confidence_at(sku, best["price"], best["width"])
    conf_any = _confidence_at(sku, po["best_any"]["price"], po["best_any"]["width"])

    verdict, title, evidence_card = "PRICE_WORKS", VERDICT_TITLES["PRICE_WORKS"], None
    if evidence["n_comparable"] < 30 or (conf_any["label"] == "Low") or \
            (best is not None and best["confidence"] == "Low"):
        verdict, title = "NEEDS_EVIDENCE", VERDICT_TITLES["NEEDS_EVIDENCE"]
        evidence_card = dict(message=f"We found only {evidence['n_comparable']} comparable observations "
                                     f"near ₹{sku['price']:,.0f}.",
                             options=["Widen the market corridor", "Pick a similar SKU",
                                      "Run a two-arm test first"], evidence=evidence)
    elif reach is None:
        from .diagnosis_service import diagnose_sku
        diag = diagnose_sku(session, seller_id, sku_id, goal, mode)
        top = (diag.get("bottlenecks") or [{}])[0]
        if top.get("id") not in ("price_margin", None) and float(top.get("strength", 0)) >= 0.75:
            verdict, title = "NOT_A_PRICE_PROBLEM", VERDICT_TITLES["NOT_A_PRICE_PROBLEM"]
        else:
            verdict, title = "PRICE_INFEASIBLE", VERDICT_TITLES["PRICE_INFEASIBLE"]

    payload: dict = dict(
        sku_id=sku_id, seller_id=seller_id, mode=mode, goal=goal, verdict=verdict, title=title,
        model_version=mb.version, label="estimated",
        current=dict(price=float(sku["price"]), metrics=current["metrics"], confidence=current["confidence"]),
        reach=(dict(price=reach["price"], metrics=reach["metrics"], confidence=reach["confidence"],
                    steps=int(np.ceil(abs(reach["price"] - float(sku["price"])) /
                                      max(settings.max_price_move * float(sku["price"]), 1e-9))))
               if reach is not None else None),
        shortfall=short, evidence=evidence, confidence=conf_best or conf_any,
        guardrails=GUARDRAILS, interventions=[], recommendation=None,
        considered_and_rejected=[], also_consider=None)

    # --- interventions ---------------------------------------------------------------------------
    if verdict in ("PRICE_INFEASIBLE", "NOT_A_PRICE_PROBLEM") and include_interventions:
        cards, rejected = [], []
        for cand in _intervention_candidates(sku, goal):
            if not cand.get("applicable", True):
                rejected.append(dict(id=cand["id"], reason=cand["reason"]))
                continue
            prices = S.in_corridor_grid((sku["corridor_low"], sku["corridor_high"]))
            c_ev = S.evaluate_candidate(mb, sku, cand["iv"], prices, goal=goal, mode=mode,
                                        cmp=comparables(), ece=ece_worst())
            feasible = S.best_feasible(c_ev)
            if feasible:
                # Prefer leaving the price where it is: if the intervention alone clears every
                # constraint at today's price, that is the recommendation ("same price, better
                # economics") and it needs no more price moves.
                idx_now = int(np.argmin(np.abs(c_ev["prices"] - float(sku["price"]))))
                chosen = (S.pick(c_ev, idx_now) if c_ev["checks"]["all"][idx_now] else feasible)
                status, sh = "FEASIBLE", {}
            else:
                # fall back to the candidate price that comes closest to feasibility
                idx = S.closest_index(c_ev)
                chosen = S.pick(c_ev, idx)
                status, sh = S.status_for(chosen["checks"], goal=goal, metrics=chosen["metrics"],
                                          iv=cand["iv"])
            card = intervention_card(sku, goal, mode, cand, c_ev, current, status, sh, chosen)
            entry = dict(
                id=cand["id"], label=cand["label"], status=status, params=dict(
                    price=chosen["price"], units_per_order=chosen["units_per_order"],
                    bundle_price=(chosen["price"] * 2 * float(cand["iv"].get("bundle_price_factor", 1.0))
                                  if cand["iv"].get("bundle") else None),
                    iv=cand["iv"]),
                metrics=chosen["metrics"], confidence=chosen["confidence"], evidence_n=chosen["n_eff"],
                constraints=chosen["checks"], shortfall=sh,
                tradeoffs=S.tradeoffs(chosen["metrics"], current["metrics"]),
                why=card["why"], answer=card, objective=chosen["objective"], label_chip="Estimated")
            if status == "FEASIBLE":
                cards.append(entry)
            elif status == "NEAR_MISS":
                cards.append(entry)
            else:
                rejected.append(dict(id=cand["id"], label=cand["label"], reason=_reject_reason(entry, goal),
                                     status="VIOLATES"))
        cards.sort(key=_rank_key)
        payload["interventions"] = cards[:8]
        payload["considered_and_rejected"] = rejected[:6]
        if cards:
            payload["recommendation"] = cards[0]
            payload["banner"] = BANNER_INFEASIBLE.format(
                n=len([c for c in cards if c["status"] == "FEASIBLE"]) or min(3, len(cards)))

    if verdict == "PRICE_WORKS" and best is not None:
        payload["recommendation"] = dict(
            id="PRICE", label="Price change",
            status="FEASIBLE" if po["best"] is not None else "STEP_1",
            params=dict(price=best["price"], iv={}, target_price=(ladder or {}).get("target_price"),
                        step=(ladder or {}).get("step"), steps=(ladder or {}).get("steps")),
            metrics=best["metrics"], confidence=best["confidence"], evidence_n=best["n_eff"],
            constraints=best["checks"], ladder=ladder,
            tradeoffs=S.tradeoffs(best["metrics"], current["metrics"]),
            answer=price_only_card(sku, goal, mode, best, current, ladder=ladder),
            objective=best["objective"], label_chip="Estimated")
        if include_interventions:
            payload["also_consider"] = _also_consider(sku, goal, mode, current, best)
    elif verdict == "NEEDS_EVIDENCE":
        payload["evidence_card"] = evidence_card

    payload["sensitivity"] = (SENS.analyse(mb, sku, goal, mode, comparables(), ece_worst())
                              if evidence["n_comparable"] >= 30 else
                              dict(robust=False, sensitive_to=["evidence"], details=[],
                                   tested=[], statement="Not enough evidence to test sensitivity."))
    return payload


def _reject_reason(entry: dict, goal: dict) -> str:
    fails = [k for k, v in entry["constraints"].items() if v is False]
    if "contribution_floor" in fails:
        return (f"contribution per kept order ₹{entry['metrics']['per_kept']['p50']:,.0f} stays below your "
                f"₹{goal.get('target_contribution', 60):,.0f} floor")
    if "return_cap" in fails:
        return (f"return+RTO {entry['metrics']['leakage']['p50']*100:.1f}% exceeds your "
                f"{goal.get('max_return_rto', 0.15)*100:.0f}% cap")
    if "volume_floor" in fails:
        return (f"orders/day {entry['metrics']['orders_day']['p50']:.1f} falls below your "
                f"{goal.get('min_orders', 20):.0f}/day floor")
    if "inventory" in fails:
        return "needs more stock than you hold"
    if "cash" in fails:
        return "working capital need exceeds your limit"
    return "does not pass your constraints at any price in the corridor"


def _also_consider(sku: dict, goal: dict, mode: str, current: dict, best_price: dict) -> dict | None:
    """If a non-price lever is clearly stronger than the price move, show exactly one of them."""
    prices = S.in_corridor_grid((sku["corridor_low"], sku["corridor_high"]))
    best_gain, best_entry = 0.0, None
    for cand in _intervention_candidates(sku, goal):
        if not cand.get("applicable", True):
            continue
        c_ev = S.evaluate_candidate(bundle(), sku, cand["iv"], prices, goal=goal, mode=mode,
                                    cmp=comparables(), ece=ece_worst())
        got = S.best_feasible(c_ev)
        if not got:
            continue
        gain = got["metrics"]["contribution_day"]["p50"] - best_price["metrics"]["contribution_day"]["p50"]
        if gain > best_gain:
            best_gain, best_entry = gain, dict(id=cand["id"], label=cand["label"],
                                               gain_per_day=gain, metrics=got["metrics"],
                                               price=got["price"])
    return best_entry
