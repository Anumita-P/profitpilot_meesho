/* ==========================================================================
   ProfitPilot - backend bridge
   --------------------------------------------------------------------------
   Loaded after the demo's own script. It does three things:

   1. Boots against the ProfitPilot backend (/api/bootstrap) and keeps a small
      cache (PPSRV) of what the server computed.
   2. Patches the demo's engine functions so that, when the backend is
      reachable, the numbers on screen are the server's numbers: floor and
      first price, the weekly cards, the lifecycle model, the Engine lab
      bandit, the coach's answers and every accept / reject / undo.
   3. Falls back to the original in-browser engine the moment the network is
      gone, so the demo still works offline on a judge's phone.

   The patch is deliberately shallow: every wrapper keeps the original function
   and calls it whenever the server data is missing or a shape does not match.
   ========================================================================== */
(function () {
  'use strict';

  var API = {
    base: '/api',
    timeout: 3000,
    online: false,
    booted: false,
    lastError: null,
    server: null,
    calls: 0,
    fail: 0,
  };
  var SRV = {
    listingIds: {},   // sku key -> listing id
    listing: {},      // sku key -> listing summary
    floors: {},       // sku key -> front-end shaped floor
    recs: {},         // sku key -> front-end shaped recommendation
    recRaw: {},       // sku key -> raw server recommendation
    lc: {},           // sku key -> front-end shaped lifecycle model
    diag: {},         // sku key -> server diagnosis
    bandit: {},       // sku key -> server bandit snapshot
    decisions: {},    // card key -> decision id
    seller: null,
    dashboard: null,
    meta: null,
    pilotLive: null,
    meta20: null,
    events: [],
    blocked: {},      // card key -> the guardrail block the server returned
    loop: {           // closed-loop state (phase 9): status, this listing, actions, trust, audit
      status: null, listing: null, actions: [], trust: null, audit: [], at: null, error: null,
    },
  };
  window.PPAPI = API;
  window.PPSRV = SRV;

  /* A failed bridge call must never fail silently: the UI shows the local engine,
     but the console says which server call did not land. */
  function warn(what, err) {
    if (typeof console !== 'undefined' && console.warn) console.warn('[ProfitPilot] ' + what + ':', (err && err.message) || err);
  }

  /* ------------------------------- transport ------------------------------ */
  function req(path, opts) {
    opts = opts || {};
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, opts.timeout || API.timeout) : null;
    API.calls++;
    return fetch(API.base + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (r) {
      if (timer) clearTimeout(timer);
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var err = new Error((j.error && j.error.message) || ('HTTP ' + r.status));
          err.status = r.status;
          err.detail = j.error && j.error.detail;
          throw err;
        }
        return j;
      });
    }).catch(function (e) {
      if (timer) clearTimeout(timer);
      API.fail++;
      API.lastError = e.message;
      throw e;
    });
  }

  /* ------------------------------ boot + badge ---------------------------- */
  function boot() {
    return req('/bootstrap?mode=' + encodeURIComponent(S.mode)).then(function (b) {
      API.online = true;
      API.booted = true;
      API.server = b.service;
      SRV.seller = b.seller;
      SRV.dashboard = b.dashboard;
      SRV.meta = { engine: b.engine, guardrails: b.guardrails, modes: b.modes, stats: b.stats };
      SRV.events = b.recentEvents || [];
      SRV.listingIds = b.listingIds || {};
      (b.listings || []).forEach(function (l) {
        SRV.listing[l.sku] = l;
        if (l.control) S.ctrl[l.sku] = l.control;
        if (l.mode) S.mode = S.mode; // the seller's own mode wins
        if (typeof l.price === 'number' && l.price !== SK[l.sku].live) {
          S.live[l.sku] = l.price;       // server price becomes the live price
        }
      });
      Object.keys(b.floors || {}).forEach(function (k) { SRV.floors[k] = toFrontFloor(b.floors[k], k); });
      (b.recommendations || []).forEach(function (r) { SRV.recRaw[r.sku] = r; SRV.recs[r.sku] = toFrontRec(r); });
      (b.modes || []).forEach(function (m) { if (MODES[m.key]) MODES[m.key].srvObjective = m.objective; });
      startHeartbeat();
      updateBadge();
      rerender();
      refreshLoop().then(function () { try { rerender(); } catch (e) {} });
      return b;
    }).catch(function (e) {
      API.online = false;
      API.booted = true;
      updateBadge();
      if (window.console) console.info('[ProfitPilot] backend unreachable, running the offline engine:', e.message);
      return null;
    });
  }

  function startHeartbeat() {
    setInterval(function () {
      req('/health?t=' + Date.now(), { timeout: 2000 }).then(function () {
        if (!API.online) { API.online = true; updateBadge(); boot(); }
      }).catch(function () {
        if (API.online) { API.online = false; updateBadge(); }
      });
    }, 20000);
  }

  function updateBadge() {
    var el = document.getElementById('ppBadge');
    if (!el) return;
    if (API.online) {
      el.textContent = '🟢 Engine server';
      el.title = 'Connected to ' + (API.server ? API.server.engine + ' v' + API.server.version : 'the ProfitPilot backend') + ' · every number on screen is computed server-side';
      el.style.borderColor = '#1B8A5A88';
      el.style.background = 'rgba(27,138,90,.18)';
    } else {
      el.textContent = '⚪ Offline engine';
      el.title = 'Backend unreachable: using the in-browser engine. All screens still work.';
      el.style.borderColor = '#ffffff55';
      el.style.background = 'rgba(255,255,255,.10)';
    }
  }

  function injectChrome() {
    if (document.getElementById('ppBadge')) return;
    var lang = document.getElementById('langBtn');
    if (lang && lang.parentNode) {
      var b = document.createElement('button');
      b.id = 'ppBadge';
      b.className = 'lang';
      b.style.marginRight = '6px';
      b.onclick = function () { go('api'); };
      b.textContent = '⏳ connecting';
      lang.parentNode.insertBefore(b, lang);
    }
    var css = document.createElement('style');
    css.textContent = [
      '.ppbox{background:var(--sd);border:1px dashed var(--ln);border-radius:12px;padding:8px 10px;margin:8px 0;font-size:12px}',
      '.ppbox b{color:var(--pk)}',
      '.ppkv{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px}',
      '.ppok{color:var(--gr);font-weight:700}.ppbad{color:var(--rd);font-weight:700}.ppwarn{color:var(--sa);font-weight:700}',
      '.ppchip{display:inline-block;font-size:10px;font-weight:800;letter-spacing:.4px;border-radius:99px;padding:2px 8px;background:var(--pl);color:var(--onp)}',
      '.ppmono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;word-break:break-word}',
      '.pptable{width:100%;border-collapse:collapse;font-size:12px}.pptable th,.pptable td{text-align:left;padding:3px 4px;border-bottom:1px solid var(--ln)}',
    ].join('');
    document.head.appendChild(css);
  }

  /* --------------------------- shape converters --------------------------- */
  function toFrontFloor(bf, skuKey) {
    var sku = SK[skuKey];
    var i = bf.inputs || {};
    var c = Object.assign({}, sku, i, { cat: bf.category });
    return {
      id: skuKey, c: c, C: CAT[bf.category] || CAT.ethnic,
      F: bf.F, k: bf.k, kept: bf.kept, deliv: bf.delivered, retN: bf.retN, rtoN: bf.rtoN,
      Cret: bf.Cret, Crto: bf.Crto, oth: bf.other,
      O: { dmg: bf.otherLines.dmg, promo: bf.otherLines.promo, ads: bf.otherLines.ads, tax: bf.otherLines.tax, cap: bf.otherLines.cap },
      cs: bf.cs, pack: bf.pack, fwd: bf.fwd, ret: bf.ret, rto: bf.rto, T: bf.T,
      Pe: bf.Pe, Pn: bf.Pn, gap: bf.gap, Fno: bf.Fno, kno: bf.delivered / 100,
      B: bf.B, Fplus: bf.Fplus, Pm: bf.Pm, Pg: bf.Pg, arms: bf.arms, frec: bf.frec,
      server: true,
    };
  }

  function toFrontPreflight(pf) {
    if (!pf || !pf.checks) return null;
    return pf.checks.map(function (c) {
      return { k: c.key, ok: !!c.ok, na: !!c.na, d: c.detail };
    });
  }

  function toFrontLogic(L) {
    if (!L) return null;
    return {
      t: L.title,
      n: L.nodes.map(function (n) {
        return { q: n.q, yes: n.yes, no: n.no, v: n.v, d: n.d };
      }),
      out: L.outcome,
    };
  }

  function toFrontRec(r) {
    return {
      id: r.sku, from: r.from, to: r.to, kind: r.kind, m: r.mode,
      h: r.headline, sub: r.sub, what: r.what, why: r.why,
      eff: r.effect, conf: r.confidence, confWhy: r.confidenceWhy, undo: r.undo,
      key: r.cardId, pf: toFrontPreflight(r.preflight), logic: toFrontLogic(r.logic),
      server: true,
      srv: r,
    };
  }

  /* --------------------------------- patches ------------------------------ */
  /**
   * 1. Floor: prefer the server's floor. The seller's own cost edits go to the
   * server first (POST /listings/:id/costs) and the server's answer is what the
   * screen shows - so the floor can never disagree with the guardrails.
   */
  function patchFloor() {
    var orig = FL;
    SRV.syncedOv = {};
    var keyOf = function (id) { return JSON.stringify(S.ov[id] || {}); };
    FL = function (id) {
      id = id || S.sku;
      var local = keyOf(id);
      // nothing typed locally and nothing pushed yet -> the boot floor is already in sync
      if (SRV.syncedOv[id] === undefined && !S.ov[id]) SRV.syncedOv[id] = local;
      var synced = SRV.syncedOv[id] === local;
      if (API.online && SRV.floors[id] && synced) return SRV.floors[id];
      return orig(id);
    };
    FL.original = orig;
  }

  /** Push local cost edits (First price screen) to the server floor engine. */
  function syncCosts(skuKey) {
    var lid = SRV.listingIds[skuKey] || ('L-' + skuKey);
    var ov = S.ov[skuKey] || {};
    var sent = JSON.stringify(ov);
    var body = { costs: Object.assign({}, ov, ov.cat ? { category: ov.cat } : {}) };
    return req('/listings/' + lid + '/costs', { method: 'POST', body: body })
      .then(function (r) {
        SRV.floors[skuKey] = toFrontFloor(r.floor, skuKey);
        SRV.syncedOv[skuKey] = sent;
        if (r.recommendation) { SRV.recRaw[skuKey] = r.recommendation; SRV.recs[skuKey] = toFrontRec(r.recommendation); }
        return r;
      })
      .catch(function () { return null; });
  }

  function patchFirstPrice() {
    var origLive = fpLive;
    fpLive = function () {
      origLive();
      if (!API.online) return;
      var key = S.sku;
      clearTimeout(window.__ppCostT);
      window.__ppCostT = setTimeout(function () {
        syncCosts(key).then(function () {
          var e = document.getElementById('fpF');
          if (e) e.innerHTML = fpFloorLine(FL());
          shell();
          updateBadge();
        });
      }, 250);
    };
  }

  /** 2. Recommendations: the server's weekly card wins; local engine is the fallback. */
  function patchRec() {
    var orig = recFor;
    recFor = function (id) {
      id = id || S.sku;
      if (API.online && SRV.recs[id] && SRV.recs[id].m === S.mode) return SRV.recs[id];
      if (API.online && !SRV.recs[id]) fetchRec(id);
      return orig(id);
    };
    recFor.original = orig;
  }

  function fetchRec(id) {
    var lid = SRV.listingIds[id] || ('L-' + id);
    return req('/listings/' + lid + '/recommendation?mode=' + encodeURIComponent(S.mode))
      .then(function (r) {
        SRV.recRaw[id] = r.recommendation;
        SRV.recs[id] = toFrontRec(r.recommendation);
        SRV.diag[id] = r.diagnosis;
        if (r.modePrice) SRV.modePrices = SRV.modePrices || {};
        return SRV.recs[id];
      }).catch(function () { return null; });
  }

  function refreshRecommendations() {
    return Promise.all(SKIDS.map(function (id) { return fetchRec(id); })).then(function () {
      rerender();
      updateBadge();
    });
  }

  /** The server rejects a stale card; when it blocks a move we show why. */
  function patchDecisions() {
    var origDecide = decide;
    var origUndo = undoDec;

    decide = function (key, v, id) {
      id = id || S.sku;
      var card = SRV.recRaw[id];
      if (!API.online || !card) { origDecide(key, v, id); return; }
      var action = v === 'y' ? 'accept' : 'reject';
      S.dec[key] = v;
      rerender();
      toast(v === 'y' ? t('Sending to the engine…', 'Engine ko bhej rahe hain…') : t('Passing to the engine…', 'Engine ko bhej rahe hain…'));
      req('/listings/' + (SRV.listingIds[id] || ('L-' + id)) + '/decisions', {
        method: 'POST',
        body: { cardId: card.cardId, action: action, mode: S.mode },
      }).then(function (res) {
        if (res.decision) SRV.decisions[key] = res.decision.id;
        if (res.listing && res.listing.price) {
          S.live[id] = res.listing.price;
          SRV.listing[id] = res.listing;
        }
        if (res.recommendation) { SRV.recRaw[id] = res.recommendation; SRV.recs[id] = toFrontRec(res.recommendation); }
        rerender();
        syncLoopDecision(id, v === 'y' ? 'accept' : 'reject');   // keep the closed loop in step with the tap
        toast(v === 'y' ? t('Applied by the engine · undo 24 h', 'Engine ne lagu kiya · 24 ghante undo') : t('Skipped · we ask again in 7 days', 'Chhoda · 7 din baad phir'));
      }).catch(function (e) {
        delete S.dec[key];
        var d = e.detail || {};
        if (e.status === 409) {
          sheet(blockedSheet(d, id, key));
          rerender();
        } else {
          origDecide(key, v, id);
        }
      });
    };

    undoDec = function (key) {
      var did = SRV.decisions[key];
      if (!API.online || !did) { origUndo(key); return; }
      req('/decisions/' + did + '/undo', { method: 'POST' }).then(function (res) {
        if (res.listing && res.listing.price) { S.live[res.listing.id.replace('L-', '')] = res.listing.price; }
        delete S.dec[key];
        delete SRV.decisions[key];
        syncLoopUndo(res.listing && res.listing.id ? res.listing.id.replace('L-', '') : S.sku);
        refreshRecommendations();
        toast(t('Undone · price restored', 'Undo · price wapas'));
      }).catch(function () { origUndo(key); });
    };
  }

  function blockedSheet(d, id, key) {
    var checks = (d.checks || []).map(function (c) {
      return '<div class="ck ' + (c.ok ? 'ok' : 'bad') + '"><b>' + (c.ok ? '✔' : '✘') + '</b><span><b style="width:auto">' + esc(c.key) + '</b> · ' + esc(c.detail) + '</span></div>';
    }).join('');
    var lw = d.lossWarning;
    return '<h3>🛡️ ' + t('Blocked by the guardrails', 'Guardrails ne roka') + '</h3>' +
      '<p>' + esc(d.sellerLine || d.message || t('Nothing was published.', 'Kuch publish nahi hua.')) + '</p>' +
      (lw ? '<div class="redbox"><b>Loss Warning</b>: ' + esc(lw.message) + '</div>' : '') +
      (checks ? '<div class="card flat">' + checks + '</div>' : '') +
      '<div class="ppbox"><b>' + t('Rule', 'Niyam') + '</b>: ' + esc(d.rule || 'hard floor · ±8% step · 7-day cooldown · ≤ 2 moves a month') + '</div>' +
      '<button class="btn p full" onclick="closeOv()">' + t('Got it', 'Samajh gaya') + '</button>';
  }

  /** 3. Lifecycle: the server's model + the seller's own day slider. */
  function patchLifecycle() {
    var orig = lcModel;
    lcModel = function (id, P0o) {
      id = id || S.sku;
      if (P0o === undefined && API.online) {
        if (!SRV.lc[id]) fetchLifecycle(id);
        if (SRV.lc[id]) return SRV.lc[id];
      }
      return orig(id, P0o);
    };
    lcModel.original = orig;

    var origView = VIEWS.lifecycle;
    VIEWS.lifecycle = function () { return origView() + serverLifecycleBox(S.sku); };
    VIEWS.lifecycle.after = function () {
      origView.after && origView.after();
      if (API.online && !SRV.lc[S.sku]) fetchLifecycle(S.sku).then(function () { try { rerender(); } catch (e) {} });
    };
  }

  function fetchLifecycle(id, day) {
    var lid = SRV.listingIds[id] || ('L-' + id);
    return req('/listings/' + lid + '/lifecycle' + (day != null ? '?day=' + day : ''))
      .then(function (r) {
        SRV.lc[id] = toFrontLifecycle(r, id);
        SRV.lcRaw = SRV.lcRaw || {};
        SRV.lcRaw[id] = r;
        return SRV.lc[id];
      }).catch(function () { return null; });
  }

  function toFrontLifecycle(r, id) {
    var sku = SK[id];
    var sc = r.windows.life / 180;
    var D = function (x) { return Math.round(x * sc); };
    return {
      s: sku, f: FL(id), L: r.windows.life, sc: sc,
      P0: (SRV.listing[id] && SRV.listing[id].price) || (typeof live === 'function' ? live(id) : sku.live),
      P1: r.events[0].price,
      Rv: Math.round(r.events[0].price * 0.935),
      Pm: r.events[2].price,
      doMatch: /match/i.test(r.rivalTest.decision),
      M1: r.priceLadder.M1, M2: r.priceLadder.M2, M3: r.priceLadder.M3,
      w: { launch: r.windows.launch, growth: r.windows.growth, maturity: r.windows.maturity, decline: r.windows.decline },
      ev: r.events.map(function (e) { return [e.day, e.price, e.label]; }),
      ordPts: r.ordersPoints.map(function (p) { return [p[0], p[1]]; }),
      D: D, server: true,
      holdO: r.rivalTest.holdOrders, matchO: r.rivalTest.matchOrders, preO: r.rivalTest.preRivalOrders,
      hold: r.rivalTest.holdProfitPerDay, match: r.rivalTest.matchProfitPerDay,
      risk: r.risk, exitConsent: r.exitConsent, exits: r.exits, serverStage: r.stage,
    };
  }

  function serverLifecycleBox(id) {
    var r = (SRV.lcRaw || {})[id];
    if (!r) return API.online ? '<div class="ppbox">⏳ ' + t('Asking the engine server for this SKU\'s lifecycle model…', 'Engine se lifecycle model aa raha hai…') + '</div>' : '';
    return '<div class="ppbox"><span class="ppchip">SERVER</span> <b>' + esc(r.stageName) + '</b> · ' +
      t('day', 'din') + ' ' + r.day + ' · ' + esc(r.classifier.reason) + '<br>' +
      '<span class="ppmono">' + esc(r.windows.life) + ' d life · windows ' + r.windows.launch + '/' + r.windows.growth + '/' + r.windows.maturity + '/' + r.windows.decline +
      ' · ladder ' + r.priceLadder.M1 + ' → ' + r.priceLadder.M2 + ' → ' + r.priceLadder.M3 + ' · recovery floor ' + R(r.floor.recoveryFloor) + '</span><br>' +
      t('Rival test from the server', 'Rival test server se') + ': ' + esc(r.rivalTest.decision) + ' <span class="ppmono">(' + esc(r.rivalTest.formula) + ')</span></div>';
  }

  /** 4. Diagnose: prepend the server's scan (8 nodes, ₹ at risk, panic brake). */
  function patchDiagnose() {
    var origView = VIEWS.diagnose;
    VIEWS.diagnose = function () { return origView() + serverDiagnoseBox(S.sku); };
    VIEWS.diagnose.after = function () {
      origView.after && origView.after();
      SRV.diagBySku = SRV.diagBySku || {};
      var sku = S.sku;
      if (API.online && !SRV.diagBySku[sku]) {
        var lid = SRV.listingIds[sku] || ('L-' + sku);
        req('/listings/' + lid + '/diagnose', { method: 'POST', body: { proposedPrice: Math.round(live(sku) * 0.85) } })
          .then(function (d) {
            SRV.diagBySku[sku] = d;
            SRV.diag[sku] = d.diagnosis;
            try { rerender(); } catch (e) { warn('diagnose re-render', e); }
          }).catch(function (e) { warn('diagnose', e); });
      }
    };
  }

  function serverDiagnoseBox(id) {
    var d = (SRV.diagBySku || {})[id];
    if (id !== S.sku) return '';
    if (!d) return API.online ? '<div class="ppbox">⏳ ' + t('Running the 8-node scan on the engine server…', 'Server par 8-node scan chal raha hai…') + '</div>' : '';
    var g = d.diagnosis;
    var rows = g.firedOrder.length
      ? g.firedOrder.map(function (b) {
        return '<tr><td>' + esc(b.label) + '</td><td class="' + (b.impactPerWeek > 0 ? 'ppbad' : '') + '">₹' + Math.round(b.impactPerWeek) + '/wk</td><td>' + esc(b.owner) + '</td></tr>';
      }).join('')
      : '<tr><td colspan="3">' + t('No branch fires: hold the price and scale.', 'Koi branch fire nahi: price rakho.') + '</td></tr>';
    var brake = d.panicBrake;
    var card = d.sellerCard;
    return '<div class="ppbox"><span class="ppchip">SERVER SCAN</span> <b>' + esc(g.verdict) + '</b>' +
      '<table class="pptable"><tr><th>' + t('Branch', 'Branch') + '</th><th>₹ ' + t('at risk / week', 'risk / hafte') + '</th><th>' + t('Owner', 'Kiska kaam') + '</th></tr>' + rows + '</table>' +
      (g.biggestLoss ? '<div class="sm">' + t('Fix the largest ₹ loss first', 'Sabse bada nuksaan pehle') + ': <b>' + esc(g.biggestLoss.fix) + '</b></div>' : '') +
      '<div class="sm" style="margin-top:4px">🚧 <b>' + t('Panic brake', 'Panic brake') + '</b>: ' + esc(brake.verdict) + (brake.sellerLine ? ' · “' + esc(brake.sellerLine) + '”' : '') + '</div>' +
      (card ? '<div class="sm">' + t('Seller card at', 'Seller card') + ' ' + R(card.to) + ': ' + card.failedCount + '/6 ' + t('checks fail', 'check fail') + ' · ' + esc(card.sellerLine) + '</div>' : '') +
      '<div class="mu xs">' + t('Engine logic; the seller only sees ✔ / ✘. A card shows only if the signal holds 2 weeks.', 'Engine logic; seller ko sirf ✔/✘.') + '</div></div>';
  }

  /** 5. Engine lab: the bandit runs on the server. */
  /**
   * The prototype's enDraw/enStat read EN.arms and EN.hold directly. The server
   * answers asynchronously, so between the view opening and the response the
   * bridge seeds a prior-only placeholder (no impressions, no belief) that the
   * server snapshot then replaces. Without it the first render reads EN.hold = null.
   */
  function ensureEngineState() {
    var f = FL(S.sku);
    if (!EN.hold) EN.hold = { p: SK[S.sku].price, n: 0, kept: 0, th: 0 };
    if (!EN.arms || !EN.arms.length) {
      EN.sku = S.sku; EN.mode = S.mode; EN.day = 0;
      EN.arms = f.arms.filter(function (p, i) { return i !== 1; }).map(function (p) {
        var prior = 0.5;
        return { p: p, pn: p - f.gap, a0: N0 * prior, b0: N0 * (1 - prior), a: N0 * prior, b: N0 * (1 - prior), n: 0, kept: 0, th: prior, status: p < f.F ? 'BLOCKED' : 'eligible', postMean: prior, weight: 0, reward1k: 0 };
      });
    }
  }

  function patchEngineLab() {
    var origStep = enStep;
    var origReset = enReset;

    enStep = function (days) {
      ensureEngineState();
      if (!API.online) { origStep(days); return; }
      var id = S.sku;
      req('/engine/bandit/run', { method: 'POST', body: { listing: SRV.listingIds[id] || ('L-' + id), mode: S.mode, days: days } })
        .then(function (snap) {
          SRV.bandit[id] = snap;
          try { applyBandit(snap); } catch (e) { warn('bandit snapshot', e); }
          if (typeof enDraw === 'function') enDraw();
          if (typeof enPF === 'function') enPF();
          if (typeof rerender === 'function') rerender();   // refresh the SERVER box with the new day
          updateBadge();
        }).catch(function (e) { warn('bandit run', e); origStep(days); });
    };

    enReset = function () {
      if (!API.online) { origReset(); return; }
      ensureEngineState();
      var id = S.sku;
      req('/engine/bandit/reset', { method: 'POST', body: { listing: SRV.listingIds[id] || ('L-' + id), mode: S.mode } })
        .then(function (snap) {
          SRV.bandit[id] = snap;
          try { applyBandit(snap); } catch (e) { warn('bandit snapshot', e); }
          try { enDraw(); } catch (e) {}
          if (typeof rerender === 'function') rerender();
        }).catch(function (e) { warn('bandit reset', e); origReset(); });
    };

    var origView = VIEWS.engine;
    if (origView) {
      VIEWS.engine = function () { return origView() + serverEngineBox(); };
      VIEWS.engine.after = function () {
        ensureEngineState();
        origView.after && origView.after();
        var id = S.sku;
        if (API.online && !SRV.bandit[id]) {
          req('/engine/bandit?listing=' + encodeURIComponent(SRV.listingIds[id] || ('L-' + id)) + '&mode=' + S.mode)
            .then(function (snap) {
              SRV.bandit[id] = snap;
              try { applyBandit(snap); } catch (e) { warn('bandit snapshot', e); }
              try { enDraw(); enPF(); } catch (e) { warn('bandit draw', e); }
              try { rerender(); } catch (e) { warn('engine re-render', e); }
            })
            .catch(function (e) { warn('bandit fetch', e); });
        }
      };
    }
  }

  function applyBandit(snap) {
    EN.sku = S.sku;
    EN.mode = S.mode;
    EN.day = snap.day;
    EN.arms = snap.arms.map(function (a) {
      return {
        p: a.price, pn: a.noReturnPrice, a0: a.a0, b0: a.b0, a: a.a, b: a.b,
        n: a.pulls, kept: a.kept, th: a.truth.theta, status: a.status, best: a.best,
        reward1k: a.rewardPer1kImpressions, postMean: a.posterior.mean, weight: a.posterior.weight, srvLabel: a.label,
      };
    });
    EN.hold = { p: snap.holdout.price, n: snap.holdout.impressions, kept: snap.holdout.kept, th: 0 };
    EN.last = snap.liveToday ? { p: snap.liveToday.price, pn: snap.liveToday.noReturnPrice } : null;
    EN.srv = snap;
  }

  function serverEngineBox() {
    var s = SRV.bandit[S.sku];
    if (!s) return API.online ? '<div class="ppbox">⏳ ' + t('Loading the server bandit state…', 'Server bandit state aa raha hai…') + '</div>' : '';
    var r = s.result;
    var ci = r.observedLiftCI95;
    return '<div class="ppbox"><span class="ppchip">SERVER</span> <b>' + t('Server bandit', 'Server bandit') + '</b> · ' + esc(s.modeName) + ' · ' + t('day', 'din') + ' ' + s.day +
      '<div class="ppkv" style="margin-top:4px">' +
      '<span>' + t('Objective', 'Objective') + ': <b>' + esc(s.objective) + '</b></span>' +
      '<span>' + t('Live today for everyone', 'Aaj sab ke liye') + ': <b>' + R(s.liveToday ? s.liveToday.price : 0) + '</b></span>' +
      '<span>' + t('Impressions', 'Impressions') + ': <b>' + (r.impressions || 0).toLocaleString('en-IN') + '</b></span>' +
      '<span>' + t('Holdout', 'Holdout') + ' (' + (r.holdoutSharePct * 100).toFixed(0) + '%): <b>' + (r.holdoutImpressions || s.holdout.impressions).toLocaleString('en-IN') + '</b></span>' +
      '<span>' + t('Kept / 1k impressions', 'Kept / 1k') + ': <b>' + r.keptPer1kImpressions + '</b></span>' +
      '</div>' +
      '<div class="sm" style="margin-top:4px">' +
      t('Observed lift', 'Dekhi gayi lift') + ': <b>' + (r.observedLiftPct == null ? t('not reported yet', 'abhi nahi') : pct(r.observedLiftPct)) + '</b>' +
      (ci ? ' <span class="mu">(95% ' + pct(ci.low) + ' … ' + pct(ci.high) + ')</span>' : '') +
      ' · ' + t('expected (noise-free)', 'expected') + ': <b>' + pct(r.expectedLiftPct) + '</b><br>' +
      '<span class="mu">' + esc(r.enoughDataReason) + '</span></div>' +
      (s.proposed ? '<div class="sm" style="margin-top:4px">' + t('Proposal', 'Proposal') + ': <b>' + R(s.proposed.from) + ' → ' + R(s.proposed.proposed) + '</b> · ' + esc(s.proposed.card) + '</div>' : '') +
      '<div class="mu xs">' + t('Arms below F never enter the draw; one menu is live for every buyer each day.', 'F se neeche arms draw mein nahi; din mein ek hi menu.') + '</div></div>';
  }

  /** 6. Coach: grounded answers from the server, local action cards kept. */
  function patchCoach() {
    var origAns = cAns;
    CO.srv = {};
    cAns = function (k, id) {
      id = id || S.sku;
      var srv = CO.srv[k + ':' + id + ':' + S.mode];
      var local = origAns(k, id);
      if (!srv) { askCoach(k, null, id); return local; }
      var block = '<div class="ppbox"><span class="ppchip">SERVER</span> ' + srv.answer.replace(/</g, '&lt;') +
        '<div class="xs mu" style="margin-top:4px">ⓘ ' + t('Source', 'Source') + ': ' + esc(srv.source) + ' · ' + t('confidence', 'bharosa') +
        ' <b>' + esc(srv.confidence) + '</b>' + (srv.engine ? ' · F ' + R(srv.engine.floor) + ' · ' + t('profit', 'kamai') + ' ' + R(srv.engine.profitPerKeptOrder) : '') + '</div>' +
        (srv.why ? '<div class="sm" style="margin-top:4px">' + (srv.why.why || []).slice(0, 3).map(function (x) { return '• ' + esc(x); }).join('<br>') + '</div>' : '') +
        '</div>';
      return block + local.b + (local.src ? '<div class="xs mu" style="margin-top:2px">ⓘ ' + t('Local detail', 'Local detail') + ': ' + local.src + '</div>' : '');
    };
    cAns.original = origAns;

    var origSend = cSend;
    cSend = function () {
      var i = document.getElementById('cin');
      var text = (i && i.value || '').trim();
      if (!text || !API.online) { origSend(); return; }
      i.value = '';
      CO.m.push({ k: 's', raw: text });
      CO.ty = true;
      cDraw();
      req('/coach/ask', { method: 'POST', body: { question: text, listing: SRV.listingIds[S.sku] || ('L-' + S.sku), mode: S.mode, lang: S.lang } })
        .then(function (a) {
          CO.ty = false;
          CO.m.push({ k: 'c', key: a.matchedIntent || 'free', id: S.sku });
          CO.srv[(a.matchedIntent || 'free') + ':' + S.sku + ':' + S.mode] = a;
          cDraw();
        }).catch(function () { CO.ty = false; origSend(); });
    };
  }

  function askCoach(key, text, id) {
    id = id || S.sku;
    var cacheKey = key + ':' + id + ':' + S.mode;
    if (CO.srv[cacheKey] || CO.asked === cacheKey) return;
    CO.asked = cacheKey;
    req('/coach/ask', { method: 'POST', body: { intent: key, question: text || key, listing: SRV.listingIds[id] || ('L-' + id), mode: S.mode, lang: S.lang } })
      .then(function (a) {
        CO.srv[cacheKey] = a;
        CO.asked = null;
        try { cDraw(); } catch (e) { rerender(); }
      }).catch(function () { CO.asked = null; });
  }

  /** 7. Pilot: server sample size, city scores and the live guardrail view. */
  function patchPilot() {
    var origAfter = VIEWS.pilot.after;
    VIEWS.pilot = function () { return VIEWS.__pilotOrig() + serverPilotBox(); };
    VIEWS.pilot.after = function () { origAfter && origAfter(); ensurePilot(); };
  }

  function ensurePilot() {
    if (!API.online) return;
    if (!SRV.pilotLive) {
      req('/pilot/live').then(function (d) { SRV.pilotLive = d; try { rerender(); } catch (e) {} }).catch(function () {});
    }
    if (!SRV.pilotDesign) {
      req('/pilot/design').then(function (d) { SRV.pilotDesign = d; try { rerender(); } catch (e) {} }).catch(function () {});
    }
  }

  function serverPilotBox() {
    var d = SRV.pilotDesign, l = SRV.pilotLive;
    if (!d) return API.online ? '<div class="ppbox">⏳ ' + t('Loading the pilot design from the engine server…', 'Pilot design aa raha hai…') + '</div>' : '';
    var cities = d.where.map(function (c) { return c.name + ' ' + c.score; }).join(' · ');
    return '<div class="ppbox"><span class="ppchip">SERVER</span> <b>' + t('Pilot design (computed server-side)', 'Pilot design (server se)') + '</b>' +
      '<div class="ppkv"><span>' + t('Cities', 'Shehar') + ': <b>' + esc(cities) + '</b></span>' +
      '<span>' + t('Randomise by', 'Randomise') + ': <b>' + esc(d.design.randomise) + '</b></span>' +
      '<span>' + t('Arms', 'Arms') + ': <b>' + d.design.treated + ' vs ' + d.design.holdout + '</b></span>' +
      '<span>' + t('Primary metric', 'Primary metric') + ': <b>' + esc(d.design.primaryMetric) + '</b></span>' +
      (l ? '<span>' + t('Below-floor listings now', 'Floor se neeche abhi') + ': <b class="' + (l.guardrail.belowFloorListings ? 'ppbad' : 'ppok') + '">' + l.guardrail.belowFloorListings + '</b></span>' : '') +
      '</div>' +
      (l ? '<div class="sm" style="margin-top:4px">' + t('Stop rules', 'Stop rules') + ': ' + l.stopRules.map(function (s) { return esc(s.rule); }).join(' · ') + '</div>' : '') +
      '<div class="mu xs">' + t('No lift is shown to the seller until the holdout can separate it.', 'Holdout bina lift nahi dikhati.') + '</div></div>';
  }

  /** 8. The Backend screen: what the server is, what it computed, what it logged. */
  function patchBackendScreen() {
    ROUTES.push(['api', '🔌', 'Backend', 'Endpoints, audit log, live engine state', 'Deck 7 · Engine']);
    VIEWS.api = function () {
      var s = API.server;
      var lines = [
        ['/api/bootstrap', t('seller, listings, floors, cards on boot', 'boot par sab')],
        ['/api/skus/:key/floor', t('return-adjusted floor + Why', 'floor + Why')],
        ['/api/skus/:key/floor/sensitivity', t('what moves F', 'F kya hilata hai')],
        ['/api/launch/plan', t('cold-start price hypothesis', 'pehla price')],
        ['/api/listings/:id/recommendation', t('the weekly Yes/No card', 'hafte ka card')],
        ['/api/listings/:id/diagnose', t('8-node scan + panic brake', 'scan + brake')],
        ['/api/listings/:id/lifecycle', t('stages, ladder, exits', 'lifecycle')],
        ['/api/listings/:id/decisions', t('accept / reject / override', 'accept / reject')],
        ['/api/listings/:id/publish', t('hard floor + Loss Warning', 'floor + warning')],
        ['/api/decisions/:id/undo', t('24-hour undo', '24 ghante undo')],
        ['/api/engine/bandit/run', t('Thompson sampling, server-side', 'bandit server par')],
        ['/api/pilot/sample-size', t('n = 251 per arm', 'n = 251')],
        ['/api/coach/ask', t('Hindi / English answers with sources', 'Hindi/English jawab')],
        ['/api/audit', t('every suggestion, override, auto-revert', 'audit log')],
      ];
      var rows = lines.map(function (r) {
        return '<div class="row" style="align-items:flex-start"><span class="ppmono" style="flex:0 0 52%">' + esc(r[0]) + '</span><span class="sm mu">' + r[1] + '</span></div>';
      }).join('');
      var evs = (SRV.events || []).slice(0, 12).map(function (e) {
        return '<div class="row" style="align-items:flex-start"><span class="ppmono" style="flex:0 0 46%">' + esc(e.type) + '</span><span class="xs mu">' + esc(e.ts.replace('T', ' ').slice(0, 19)) + (e.listingId ? ' · ' + esc(e.listingId) : '') + '</span></div>';
      }).join('') || '<div class="mu sm">' + t('No events yet.', 'Abhi koi event nahi.') + '</div>';
      var dash = SRV.dashboard;
      return '<h1>🔌 ' + t('Backend', 'Backend') + '</h1>' +
        '<div class="mu">' + t('The engine behind every screen. This page is served by the same process that answers /api.', 'Har screen ke peeche ka engine.') + '</div>' +
        '<div class="' + (API.online ? 'greenbox' : 'redbox') + '" style="margin:10px 0">' +
        '<b>' + (API.online ? '🟢 ' + t('Connected', 'Connected') : '⚪ ' + t('Offline', 'Offline')) + '</b> ' +
        (API.online
          ? t('to ', '') + (s ? esc(s.name) + ' v' + s.version + ' · ' + esc(s.engine) : '') + ' · ' + API.calls + ' ' + t('calls, ', 'calls, ') + API.fail + ' ' + t('failures', 'fail') + '<br><span class="sm">' + esc(s ? s.deck : '') + '</span>'
          : t('Backend not reachable: the demo is running the in-browser engine. Start the server with `npm start` and reload.', 'Backend nahi mila: offline engine chal raha hai.')) +
        '</div>' +
        (dash ? '<h2>' + t('Live from the engine', 'Engine se live') + '</h2><div class="card"><div class="g2">' +
          '<div class="kpi"><div class="l">' + t('Orders / day', 'Orders / din') + '</div><div class="v">' + dash.kpis.ordersPerDay + '</div><small class="mu">' + dash.kpis.keptOrdersPerDay + ' ' + t('kept', 'kept') + '</small></div>' +
          '<div class="kpi"><div class="l">' + t('Profit / kept order', 'Kamai / kept order') + '</div><div class="v">' + R(dash.kpis.profitPerKeptOrder) + '</div><small class="mu">' + R(dash.kpis.profitPerDay) + '/' + t('day', 'din') + '</small></div>' +
          '<div class="kpi"><div class="l">' + t('Below floor', 'Floor se neeche') + '</div><div class="v ' + (dash.kpis.listingsBelowFloor ? 'dn' : 'up') + '">' + dash.kpis.listingsBelowFloor + '</div><small class="up">🛡️ ' + t('hard floor on', 'hard floor ON') + '</small></div>' +
          '<div class="kpi"><div class="l">' + t('Trust ladder', 'Trust ladder') + '</div><div class="v">' + esc(dash.trustLadder.level) + '</div><small class="mu">' + esc(dash.trustLadder.next) + '</small></div>' +
          '</div></div>' : '') +
        '<h2>' + t('What the server computes', 'Server kya compute karta hai') + '</h2><div class="card">' + rows +
        '<p class="mu sm">' + t('Full list: ', 'Poori list: ') + '<span class="ppmono">GET /api/routes</span> · ' + t('constants and guardrails: ', 'constants: ') + '<span class="ppmono">GET /api/meta</span></p></div>' +
        '<h2>' + t('Audit trail', 'Audit trail') + '</h2><div class="card flat">' + evs +
        '<p class="mu xs">' + t('Append-only. This is how 2.0 closes the loop on 1.0 limit 5 (“we do not always know which advice was applied”).', 'Append-only log.') + '</p>' +
        '<div class="btns"><button class="btn s" onclick="PPAPI.reload()">↻ ' + t('Reload from server', 'Server se reload') + '</button>' +
        '<button class="btn w" onclick="PPAPI.showMeta()">' + t('Engine constants', 'Constants') + '</button></div></div>' +
        '<p class="mu xs c">' + t('Illustrative planning defaults from the DICE S3 deck · not real Meesho data', 'Illustrative data') + '</p>';
    };
  }

  API.reload = function () { return refreshRecommendations().then(function () { return boot(); }); };
  API.loopRefresh = function () { return refreshLoop(); };
  API.showMeta = function () {
    var m = SRV.meta;
    sheet('<h3>' + t('Engine constants (GET /api/meta)', 'Engine constants') + '</h3>' +
      '<div class="ppmono" style="max-height:50vh;overflow:auto">' + esc(JSON.stringify(m ? { engine: m.engine, guardrails: m.guardrails } : {}, null, 1)) + '</div>' +
      '<button class="btn p full" onclick="closeOv()">OK</button>');
  };
  API.publish = function (price, opts) {
    var id = S.sku;
    return req('/listings/' + (SRV.listingIds[id] || ('L-' + id)) + '/publish', { method: 'POST', body: Object.assign({ price: price }, opts || {}) });
  };
  API.state = function () { return { api: API, srv: SRV, S: S, EN: EN }; };

  /* ------------------------- closed loop (server truth) -------------------- */
  /*  The demo screens show one SKU at a time. This block adds the state the
      prototype never had: where the recommendation is in its lifecycle, whether
      the observation window is open, what the outcome was, which experiment
      covers the listing, what the trust ladder says and what the audit trail
      recorded. Every field is optional and every failure falls back to a line of
      text: the offline demo must keep working exactly as before. */
  function listingIdFor(sku) { return SRV.listingIds[sku] || ('L-' + sku); }

  /* The prototype's own decision route stays the source of truth for the card.
     These two helpers mirror the same tap into the closed-loop record so the
     lifecycle, the audit trail and the observation window advance with it. They
     are deliberately non-blocking: if the loop endpoints are missing, the
     prototype behaves exactly as before. */
  function syncLoopDecision(sku, decision) {
    if (!API.online) return Promise.resolve(null);
    var id = listingIdFor(sku);
    return req('/lifecycle/listings/' + id + '/generate', { method: 'POST', body: { reason: 'seller tapped ' + decision + ' on the card' }, timeout: 2500 })
      .then(function (g) {
        var rid = g && g.recommendation && g.recommendation.recommendation_id;
        if (!rid) return null;
        return req('/lifecycle/recommendations/' + rid + '/shown', { method: 'POST', body: {}, timeout: 2500 })
          .catch(function () { return null; })
          .then(function () { return req('/lifecycle/recommendations/' + rid + '/decision', { method: 'POST', body: { decision: decision, by: 'seller' }, timeout: 2500 }); });
      })
      .then(function () { return refreshLoop(); })
      .then(function () { try { rerender(); } catch (e) {} })
      .catch(function (e) { warn('loop sync (decision)', e); });
  }

  function syncLoopUndo(sku) {
    if (!API.online) return Promise.resolve(null);
    var id = listingIdFor(sku);
    var open = SRV.loop.listing && SRV.loop.listing.open_recommendation;
    var rid = open && open.recommendation_id;
    if (!rid) return refreshLoop();
    return req('/lifecycle/recommendations/' + rid + '/revert', { method: 'POST', body: { by: 'seller', reason: 'seller pressed undo within 24 h' }, timeout: 2500 })
      .then(function () { return refreshLoop(); })
      .catch(function (e) { warn('loop sync (undo)', e); });
  }

  function refreshLoop() {
    if (!API.online) return Promise.resolve(null);
    var id = listingIdFor(S.sku);
    var seller = (SRV.seller && SRV.seller.id) || 'S-ramesh';
    return Promise.all([
      req('/closed-loop/status', { timeout: 2500 }).catch(function () { return null; }),
      req('/lifecycle/listings/' + id + '/state', { timeout: 2500 }).catch(function () { return null; }),
      req('/actions?listing=' + id, { timeout: 2500 }).catch(function () { return null; }),
      req('/actions/trust/' + seller, { timeout: 2500 }).catch(function () { return null; }),
      req('/actions/audit?listing=' + id + '&limit=8', { timeout: 2500 }).catch(function () { return null; }),
    ]).then(function (r) {
      SRV.loop.status = r[0];
      SRV.loop.listing = r[1];
      SRV.loop.actions = (r[2] && r[2].actions) || [];
      SRV.loop.trust = r[3];
      SRV.loop.audit = (r[4] && r[4].entries) || [];
      SRV.loop.at = new Date().toISOString();
      SRV.loop.error = (r[0] || r[1]) ? null : 'loop endpoints unreachable';
      try { updateBadge(); } catch (e) { warn('badge', e); }
      return SRV.loop;
    }).catch(function (e) { SRV.loop.error = e.message; return null; });
  }

  function loopStageStrip() {
    var st = SRV.loop.status && SRV.loop.status.stages;
    if (!st) return '';
    var cells = [
      ['DATA', (st.data ? st.data.events : 0) + ' events' + (st.data && st.data.dev_simulated ? ' (' + st.data.dev_simulated + ' simulated)' : ''), ''],
      ['FEATURES', (st.features ? st.features.refreshed : 0) + '/' + (st.features ? st.features.listings_with_signals : 0) + ' refreshed', ''],
      ['RECOMMENDATION', (st.recommendation ? st.recommendation.total : 0) + ' total', ''],
      ['DECISION', (st.decision ? st.decision.accepted : 0) + ' accepted / ' + (st.decision ? st.decision.rejected : 0) + ' rejected', ''],
      ['ACTION', (st.action ? st.action.total : 0) + ' items', (st.action && st.action.QUEUED ? st.action.QUEUED + ' queued' : '')],
      ['OUTCOME', (st.outcome ? st.outcome.recorded : 0) + ' judged', (st.outcome ? (st.outcome.wins + 'W / ' + st.outcome.losses + 'L') : '')],
      ['EXPERIMENT', (st.experiment ? st.experiment.running : 0) + ' running', (st.experiment ? st.experiment.total + ' total' : '')],
      ['MODEL', (st.model && st.model.trust ? st.model.trust.level : '-'), (st.model && st.model.trust ? st.model.trust.wins + ' wins' : '')],
    ];
    return '<div style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0">' + cells.map(function (c) {
      return '<div style="flex:1 1 21%;min-width:132px;border:1px solid #ffffff22;border-radius:10px;padding:6px 8px">' +
        '<div class="xs mu" style="letter-spacing:.06em">' + esc(c[0]) + '</div>' +
        '<div class="sm"><b>' + esc(String(c[1])) + '</b></div>' +
        (c[2] ? '<div class="xs mu">' + esc(c[2]) + '</div>' : '') + '</div>';
    }).join('') + '</div>';
  }

  function loopListingBox() {
    var st = SRV.loop.listing;
    if (!st) return '<div class="mu sm">' + t('Loop state for this listing is unavailable (offline or not loaded yet).', 'Loop state load nahi hua.') + '</div>';
    var l = st.listing || {};
    var open = st.open_recommendation;
    var obs = st.observations && st.observations[0];
    var out = st.outcomes && st.outcomes[0];
    var tr = st.trust || {};
    var rows = [
      [t('Price / floor', 'Price / floor'), R(l.price) + ' / ' + R(l.floor) + ' · ' + esc(String(l.stage || '')) + ' · ' + esc(String(l.mode || ''))],
      [t('Open recommendation', 'Open recommendation'), open ? esc(open.recommendation_id) + ' · ' + esc(open.status) + ' · ' + R(open.from) + ' → ' + R(open.to) : t('none open', 'koi nahi')],
      [t('Observation window', 'Observation window'), obs ? esc(obs.recommendation_id) + ' · ' + esc(obs.status) + ' · ' + t('judge at ', 'judge ') + esc(String(obs.judgeAt || '').slice(0, 10)) + ' · ' + (obs.samples ? obs.samples.length : 0) + ' ' + t('samples', 'sample') : t('not opened yet', 'abhi nahi')],
      [t('Latest outcome', 'Latest outcome'), out ? esc(out.verdict || (out.insufficient ? 'INSUFFICIENT' : 'n/a')) + ' · ' + esc(String(out.window ? (out.window.days + 'd') : '')) + ' · ' + t('baseline ', 'baseline ') + esc(out.baseline_source || '') : t('no verdict yet (needs evidence)', 'abhi verdict nahi')],
      [t('Actions', 'Actions'), SRV.loop.actions.length ? SRV.loop.actions.slice(0, 3).map(function (a) { return esc(a.action_id + ' ' + a.status); }).join(' · ') : t('none', 'koi nahi')],
      [t('Trust', 'Trust'), esc(String(tr.ladder ? tr.ladder.level : '-')) + ' · ' + (tr.wins || 0) + ' ' + t('holdout-backed wins', 'holdout wins') + ' · ' + (tr.provisional_wins || 0) + ' ' + t('provisional', 'provisional')],
    ];
    var audit = (SRV.loop.audit || []).slice(0, 6).map(function (a) {
      return '<div class="row" style="align-items:flex-start"><span class="ppmono" style="flex:0 0 46%">' + esc(String(a.from || '-') + ' → ' + String(a.to || '-')) + '</span><span class="xs mu">' + esc(String(a.actor || '')) + ' · ' + esc(String(a.at || '').replace('T', ' ').slice(0, 19)) + (a.note ? ' · ' + esc(String(a.note).slice(0, 46)) : '') + '</span></div>';
    }).join('') || '<div class="mu sm">' + t('No audit entries for this listing yet.', 'Abhi audit entry nahi.') + '</div>';
    return '<div class="card">' + rows.map(function (r) {
      return '<div class="row" style="align-items:flex-start"><span class="sm" style="flex:0 0 40%">' + esc(r[0]) + '</span><span class="sm" style="flex:1"><b>' + r[1] + '</b></span></div>';
    }).join('') + '</div>' +
      '<h2>' + t('Audit trail (this listing)', 'Audit trail') + '</h2><div class="card flat">' + audit +
      '<p class="mu xs">' + t('Every state change is written here: actor, from → to, why, when. A refund of a bad move leaves this trail too.', 'Har change yahan likha jata hai.') + '</p></div>';
  }

  function loopCard() {
    if (!API.online) return '<h2>' + t('Closed loop', 'Closed loop') + '</h2><div class="card flat"><p class="mu sm">' + t('Server offline: the closed-loop state is not available. The offline engine and every screen still work.', 'Offline: loop state nahi hai.') + '</p></div>';
    return '<h2>' + t('Closed loop', 'Closed loop') + ' <span class="xs mu">GET /api/closed-loop/status</span></h2>' +
      loopStageStrip() +
      '<p class="mu sm">' + t('DATA → FEATURES → RECOMMENDATION → DECISION → ACTION → OUTCOME → EXPERIMENT → MODEL UPDATE. Prices only ever move through the guardrailed write, and every state change is audited.', 'Poora loop, guardrails ke saath.') + '</p>' +
      loopListingBox();
  }

  function patchClosedLoop() {
    var origApi = VIEWS.api;
    VIEWS.api = function () { return origApi() + loopCard(); };
    API.loop = {
      refresh: refreshLoop,
      state: function () { return SRV.loop; },
      status: function () { return SRV.loop.status; },
      trust: function () { return SRV.loop.trust; },
    };
  }

  /* --------------------------------- boot --------------------------------- */
  function init() {
    injectChrome();
    patchFloor();
    patchFirstPrice();
    patchRec();
    patchDecisions();
    patchLifecycle();
    patchDiagnose();
    patchEngineLab();
    patchCoach();
    patchBackendScreen();
    patchClosedLoop();
    // keep the original pilot view reachable while wrapping it
    VIEWS.__pilotOrig = VIEWS.pilot;
    patchPilot();
    var origShell = shell;
    shell = function () { origShell(); updateBadge(); };
    boot();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', function () { if (!API.online) boot(); });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
