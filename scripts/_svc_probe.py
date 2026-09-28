"""Developer probe: exercise every service directly (no HTTP) and report failures per step."""
from __future__ import annotations

import sys
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.database.seed import seed_all                      # noqa: E402
from app.database.session import get_session                # noqa: E402
from app.services import (audit_service, catalog_service, demo_service, diagnosis_service,  # noqa: E402
                          employee_service, explain_service, recommendation_service,
                          reverse_pricing, simulation_service)
from app.services.runtime import comparables, ece_worst       # noqa: E402

GOAL = dict(target_contribution=60.0, min_orders=20.0, max_return_rto=0.18, cash_limit=120000.0,
            mode="margin")
GOAL25 = dict(GOAL, max_return_rto=0.25)
GOAL_C = dict(GOAL, max_return_rto=0.15, cash_limit=150000.0)


def step(name, fn):
    t = time.perf_counter()
    try:
        out = fn()
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL  {name}: {type(exc).__name__}: {exc}")
        traceback.print_exc(limit=6)
        print()
        return None
    ms = (time.perf_counter() - t) * 1000
    print(f"ok    {name:44s} {ms:7.0f} ms  {str(out)[:110]}")
    return out


def main() -> int:
    session = get_session()
    seed_all(reset=True, load_obs=False)

    step("runtime.comparables", lambda: dict(cats=len(comparables().by_cat), ece=round(ece_worst(), 5)))
    step("catalog.list_skus", lambda: {k: v for k, v in catalog_service.list_skus(session, "S-SUNITA").items()
                                       if k in ("total", "summary")})
    step("catalog.sku_detail K-101", lambda: list(catalog_service.sku_detail(session, "S-SUNITA", "K-101"))[:6])
    step("simulation.curve K-101", lambda: curve_summary(session, "K-101", GOAL))
    step("simulation.point K-101 @399", lambda: point_summary(session, "K-101", 399.0, GOAL))
    step("simulation.snapshot K-101", lambda: {k: v for k, v in
                                               simulation_service.snapshot(session, "S-SUNITA", "K-101", GOAL).items()
                                               if k in ("price", "kept_rate", "label")})
    step("recommend K-101 (A)", lambda: rec_summary(session, "K-101", GOAL))
    step("recommend K-207 (C)", lambda: rec_summary(session, "K-207", GOAL_C))
    step("recommend K-101B (B)", lambda: rec_summary(session, "K-101B", GOAL25))
    step("recommend K-330 (D)", lambda: rec_summary(session, "K-330", GOAL))
    step("recommend K-118 (F)", lambda: rec_summary(session, "K-118", GOAL))
    step("recommend K-101R clear", lambda: rec_summary(session, "K-101R",
                                                       dict(target_contribution=0.0, min_orders=30.0,
                                                            max_return_rto=0.18, cash_limit=150000.0,
                                                            mode="clear"), seller="S-RAHUL"))
    step("recommend K-101S cash", lambda: rec_summary(session, "K-101S",
                                                      dict(GOAL, cash_limit=135000.0, mode="cash")))
    step("reverse K-101R", lambda: reverse_summary(session, "K-101R",
                                                   dict(target_contribution=0.0, min_orders=30.0,
                                                        max_return_rto=0.18, cash_limit=150000.0,
                                                        mode="clear"), seller="S-RAHUL"))
    step("reverse K-330", lambda: reverse_summary(session, "K-330", GOAL))
    step("diagnosis K-118", lambda: diag_summary(session, "K-118"))
    step("explain.pipeline K-207", lambda: pipeline_summary(session, "K-207"))
    step("explain.explanation K-101", lambda: explain_summary(session, "K-101"))
    step("employee.overview", lambda: {k: (v if not isinstance(v, (list, dict)) else type(v).__name__)
                                        for k, v in employee_service.overview(session).items()})
    step("employee.interventions", lambda: len(employee_service.interventions(session)["rows"]))
    step("employee.model_health", lambda: list(employee_service.model_health(session))[:5])
    step("employee.experiments", lambda: len(employee_service.experiments(session)["designs"]))
    step("demo.list_scenarios", lambda: [s["id"] for s in demo_service.list_scenarios()])
    step("audit.counts", lambda: audit_service.counts(session))
    session.close()
    return 0


def curve_summary(session, sku, goal):
    out = simulation_service.curve(session, "S-SUNITA", sku, goal, None, None, None, 2)
    if not out:
        raise RuntimeError("empty curve")
    s = out["series"]
    i = out["prices"].index(399.0) if 399.0 in out["prices"] else len(out["prices"]) // 2
    return dict(points=out["meta"]["points"], at399=dict(orders=round(s["orders_day"]["p50"][i], 2),
                                                         per_kept=round(s["per_kept"]["p50"][i], 2)),
                rec=(out["markers"]["recommended"] or {}).get("price"),
                annotation=out["markers"]["annotation"])


def point_summary(session, sku, price, goal):
    out = simulation_service.point(session, "S-SUNITA", sku, price, goal, None)
    if not out:
        raise RuntimeError("empty point")
    return dict(per_kept=round(out["metrics"]["per_kept"]["p50"], 2),
                orders=round(out["metrics"]["orders_day"]["p50"], 2),
                conf=out["confidence"]["label"], hard=sum(1 for c in out["constraints"] if c["pass_"]))


def rec_summary(session, sku, goal, seller="S-SUNITA"):
    out = recommendation_service.recommend(session, seller, sku, goal)
    if not out:
        raise RuntimeError("empty recommendation")
    rec = out.get("recommendation") or {}
    return dict(verdict=out["verdict"], title=out["title"][:44],
                price=(rec.get("params") or {}).get("price"),
                n_interventions=len(out.get("interventions", [])),
                best_int=((out.get("interventions") or [{}])[0].get("id")))


def reverse_summary(session, sku, goal, seller="S-SUNITA"):
    out = reverse_pricing.reverse(session, seller, sku, goal)
    if not out:
        raise RuntimeError("empty reverse")
    return dict(required=(out.get("required_price") or {}).get("price"),
                n_solutions=len(out["solutions"]),
                ids=[s["id"] for s in out["solutions"][:4]])


def diag_summary(session, sku):
    out = diagnosis_service.diagnose_sku(session, "S-SUNITA", sku, GOAL)
    return dict(verdict=out["verdict"]["title"][:40], top=out["bottlenecks"][0]["id"])


def pipeline_summary(session, sku):
    out = explain_service.pipeline(session, "S-SUNITA", sku)
    return dict(nodes=[n["index"] for n in out["nodes"]])


def explain_summary(session, sku):
    out = explain_service.explanation(session, "S-SUNITA", sku, 390.0, compare_price=349.0)
    return dict(attr=len(out["attribution"]), first=out["attribution"][0])


if __name__ == "__main__":
    raise SystemExit(main())
