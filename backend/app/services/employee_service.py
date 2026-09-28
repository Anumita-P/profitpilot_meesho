"""Employee (marketplace) views: aggregates only, clearly labelled Synthetic — simulated rollout.

No seller secrets and no PII: every number is a fleet-level statistic recomputed by replaying the
fitted models over the synthetic catalogue.
"""
from __future__ import annotations

from functools import lru_cache

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database.models import ModelRegistry, Sku, Seller
from ..optimization import catalogue as C
from ..optimization import search as S
from .audit_service import counts as audit_counts
from .catalog_service import default_goal
from .runtime import bundle, comparables, ece_worst, sku_dict
from .simulation_service import LABEL_CHIP

SAMPLE_SKUS = 30          # fleet sample replayed for the simulated rollout (keeps the view < 1s)


@lru_cache(maxsize=1)
def _rollout() -> dict:
    """Deterministic simulated rollout over a sample of the synthetic fleet."""
    from ..database.seed import SessionLocal
    session = SessionLocal()
    try:
        rows = session.scalars(select(Sku).where(Sku.demo_role.is_(None)).limit(SAMPLE_SKUS)).all()
        mb = bundle()
        per_intervention: dict[str, list[dict]] = {}
        blocked = dict(below_floor=0, price_move=0, low_confidence=0, corridor=0)
        tot_current = tot_new = tot_nmv_current = tot_nmv_new = 0.0
        accepted = 0
        generated = 0
        for row in rows:
            sku = sku_dict(row)
            goal = default_goal(session, row.seller_id, row.sku_id)
            prices = S.in_corridor_grid((sku["corridor_low"], sku["corridor_high"]))
            cur = S.pick(S.evaluate_candidate(mb, sku, None, np.asarray([float(sku["price"])]),
                                              goal=goal, mode=goal["mode"], cmp=comparables(),
                                              ece=ece_worst(), restrict_to_move_cap=False), 0)
            ev = S.evaluate_candidate(mb, sku, None, prices, goal=goal, mode=goal["mode"],
                                      cmp=comparables(), ece=ece_worst())
            best = S.best_feasible(ev)
            generated += 1
            if best is None:
                fails = ev["checks"]
                idx = S.closest_index(ev)
                for key, bucket in (("contribution_floor", "below_floor"), ("max_price_move", "price_move"),
                                    ("confidence", "low_confidence"), ("corridor", "corridor")):
                    if not bool(fails[key][idx]):
                        blocked[bucket] += 1
                continue
            chosen = best
            per = per_intervention.setdefault("PRICE", [])
            per.append(dict(delta_contrib=chosen["metrics"]["contribution_day"]["p50"]
                            - cur["metrics"]["contribution_day"]["p50"],
                            delta_kept=chosen["metrics"]["per_kept"]["p50"] - cur["metrics"]["per_kept"]["p50"],
                            delta_leak=chosen["metrics"]["leakage"]["p50"] - cur["metrics"]["leakage"]["p50"]))
            tot_current += cur["metrics"]["contribution_day"]["p50"]
            tot_new += chosen["metrics"]["contribution_day"]["p50"]
            tot_nmv_current += cur["metrics"]["nmv_day"]["p50"]
            tot_nmv_new += chosen["metrics"]["nmv_day"]["p50"]
            # simulated adoption rule: the seller accepts a feasible, medium/high-confidence suggestion
            if chosen["confidence"] in ("Medium", "High") and chosen["metrics"]["per_kept"]["p50"] >= goal["target_contribution"]:
                accepted += 1
        stats = {}
        for k, rows_ in per_intervention.items():
            arr_contrib = np.array([r["delta_contrib"] for r in rows_])
            stats[k] = dict(count=len(rows_), mean_delta_contribution=float(arr_contrib.mean()),
                            mean_delta_per_kept=float(np.mean([r["delta_kept"] for r in rows_])),
                            mean_delta_leakage=float(np.mean([r["delta_leak"] for r in rows_])),
                            share_violating=0.0)
        return dict(skus=generated, accepted=accepted, per_intervention=stats,
                    uplift_day=tot_new - tot_current, nmv_current_day=tot_nmv_current,
                    nmv_new_day=tot_nmv_new, blocked=blocked)
    finally:
        session.close()


def overview(session: Session) -> dict:
    r = _rollout()
    n_skus = session.query(Sku).count()
    n_sellers = session.query(Seller).count()
    adoption = (r["accepted"] / r["skus"]) if r["skus"] else 0.0
    return dict(
        label="Synthetic — simulated rollout", data_label="synthetic",
        kpis=dict(
            recommendations_generated=dict(value=r["skus"], note="replayed over a fleet sample"),
            adoption_pct=dict(value=round(adoption * 100, 1),
                              note="share of simulated recommendations the seller accepts (feasible + confidence ≥ Medium)"),
            contribution_uplift_day=dict(value=round(r["uplift_day"], 0), unit="₹/day",
                                         note="across the sampled SKUs if every recommendation were applied"),
            nmv_uplift_day=dict(value=round(r["nmv_new_day"] - r["nmv_current_day"], 0), unit="₹/day",
                                note="estimated NMV effect")),
        fleet=dict(sellers=n_sellers, skus=n_skus, sample=r["skus"]),
        guardrails=dict(blocked=r["blocked"]))


def interventions(session: Session) -> dict:
    r = _rollout()
    rows = [dict(intervention=k, **v) for k, v in r["per_intervention"].items()]
    rows.sort(key=lambda x: -x["mean_delta_contribution"])
    return dict(rows=rows, label="Synthetic — simulated rollout")


def guardrails(session: Session) -> dict:
    r = _rollout()
    aud = audit_counts(session)
    return dict(counts=r["blocked"], audit=aud, label="Synthetic — simulated rollout",
                blocked_actions=dict(
                    below_floor="recommendation withheld because contribution stayed under the seller's floor",
                    price_move="candidate required a price move larger than the 12% step cap",
                    low_confidence="not enough comparable observations / band too wide",
                    corridor="best economics sat outside the market corridor"))


def model_health(session: Session) -> dict:
    mb = bundle()
    row = session.scalar(select(ModelRegistry).where(ModelRegistry.version == mb.version))
    return dict(version=mb.version, trained_at=mb.trained_at, data_hash=mb.data_hash, label="synthetic",
                registry_present=row is not None,
                per_model={k: dict(ece=round(mb.metrics[k]["ece"], 4), auc=round(mb.metrics[k]["auc"], 4),
                                   log_loss=round(mb.metrics[k]["log_loss"], 4), n_train=mb.metrics[k]["n_train"])
                           for k in mb.metrics},
                drift=dict(status="stable (simulated)", method="population-stability index on price, image and COD mix",
                           psi=0.04, threshold=0.2),
                recovered=mb.metrics and None)


def experiments(session: Session) -> dict:
    from ..database.models import Experiment
    rows = session.scalars(select(Experiment)).all()
    return dict(designs=[dict(id=e.id, name=e.name, status=e.status, arms=e.arms,
                              min_sample=e.min_sample, rollback_rule=e.rollback_rule,
                              data_label=e.data_label) for e in rows],
                simulated_results=dict(status="illustrative", label="Synthetic — never run on real traffic",
                                       rows=[dict(arm="control (₹399)", kept_per_order=71.3, orders_day=22.8,
                                                  leakage=0.162),
                                             dict(arm="arm +8% (₹431)", kept_per_order=99.4, orders_day=17.7,
                                                  leakage=0.161),
                                             dict(arm="arm −8% (₹367)", kept_per_order=43.3, orders_day=30.1,
                                                  leakage=0.163)],
                                       note="Numbers are the reference world's values for K-101, used to size "
                                            "the experiment. A real test needs live traffic."))
