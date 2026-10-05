/**
 * ProfitPilot 1.0 - single source of truth for every constant that appears in
 * the final deck (Meesho DICE Challenge S3, Business Track, Team Fiery Diamonds).
 *
 * Layout mirrors slide 7 ("The engine: from Meesho's data to a 1-tap answer"):
 *   DATA -> FEATURES -> MODELS -> DECISION -> ACTION
 *
 * Every block below is tagged with the slide it comes from so a reviewer can
 * trace a number in the product back to a number in the deck.
 *
 * NOTE ON DATA: all of these are planning defaults / illustrative values from
 * the deck. Nothing here is real Meesho data.
 */

/* ------------------------------------------------------------------ *
 * ENGINE CONSTANTS  (deck slide 7 box 2 "Model stack")
 * the four models the pilot actually needs are marked pilot: true
 * ------------------------------------------------------------------ */
export const ENGINE = {
  BETA: -3,          // demand elasticity prior, ln q = a + b ln p   (slide 7 box 4)
  GAMMA: 120,        // look-alike penalty above the median price    (slide 7 box 4)
  N0: 2000,          // prior sample size for the price bandit        (slide 7 box 4)
  CTR0: 0.04,        // category click-through baseline 4%
  CVR0: 0.12,        // category conversion baseline 12%
  SHARE_DISPATCHED: 0.97, // 100 placed -> 97 dispatched             (slide 2 box 1)
  SHARE_NO_RETURN_PICK: 0.30, // >30% of delivered orders pick the no-return price (slide 2 box 5)
  NO_RETURN_RETURN_DROP: 0.10, // ~10% fewer returns on no-return buyers (slide 2 box 5)
  MARKDOWN_TARGET_MARGIN: 0.03, // clearance price = F / 0.97          (slide 4 / 5)
  TARGET_MARGIN_DEFAULT: 0.15,  // "price at 15% target margin"        (slide 2 box 6)
  MARGIN_MODE_M: 0.22,          // MARGIN mode start price = F / 0.78  (slide 6 box 2)
  BREAKAGE_FREE_SHIP_KG: 0.5,   // sensitivity lever reference weight
  CASH_CYCLE_EASY_RETURNS_DAYS: 15, // assumed; flagged "confirm with Meesho" (slide 6)
  CASH_CYCLE_NO_RETURN_DAYS: 8,
  CARRY_COST_PER_MONTH: 0.02,   // ~2%/month cost of money in stock     (slide 10 box 4)
  /* Launch safety margin: the deck's cold-start trace reads "F ₹309 + ₹18 margin = ₹327 min"
     (slides 4 and 7). It is the cushion against floor-estimation error (pilot gate: floor
     within ±5% of settlement), so a day-0 opening price must clear F + margin. */
  LAUNCH_SAFETY_MARGIN_PCT: 0.058,
};

/* ------------------------------------------------------------------ *
 * GUARDRAILS  (deck slide 6 box 3 "Profit-protection layer", slide 7 box 4)
 * "on in every mode" - the backend enforces these server-side.
 * ------------------------------------------------------------------ */
export const GUARDRAILS = {
  maxStepPct: 8,            // ±8% per move
  minViewsForSanity: 1000,  // 1,000 views ≈ 5 orders -> sanity check only
  cooldownDays: 7,          // one full weekday + weekend cycle
  maxMovesPerMonth: 2,      // ≤ 2 price moves / month per SKU
  undoHours: 24,            // 24 h undo
  autoRevertDay: 14,        // judge on orders
  confirmDay: 28,           // confirm on kept orders (return-window lag)
  hardFloor: true,          // no mode publishes below F silently
  panicBrake: true,         // a cut needs the price-value branch to fire
  priceHeuristicOutsidePct: 15, // ≤ 15% outside prices already seen
  autopilotWinsRequired: 4, // 4 accepted wins -> Autopilot on 1 SKU
  autopilotCatalogueWeeks: 8, // 8 weeks -> Autopilot on the catalogue
  copilotDefaultAfterOrders: 30, // Manual until 30 orders, then Co-Pilot
  holdoutPct: 5,            // permanent 5% holdout after rollout
};

/* ------------------------------------------------------------------ *
 * CATEGORY PRIORS  (deck slide 2 box 1 table, slide 3 box 3)
 * unit return / RTO costs and the "other" cost lines are category priors
 * used when the seller has no own history. beta = the elasticty prior.
 * ------------------------------------------------------------------ */
export const CATEGORIES = {
  ethnic:  { key: 'ethnic',  name: 'Ethnic wear',    unitRet: 226, unitRto: 175, ret: 12, rto: 8, life: '3-6 months',  lifeDays: 180, beta: -3,
             other: { dmg: 4,  promo: 6,  ads: 12, tax: 10, cap: 12 } },
  kitchen: { key: 'kitchen', name: 'Home & kitchen', unitRet: 240, unitRto: 190, ret: 5,  rto: 7, life: '18-24 months', lifeDays: 360, beta: -3,
             other: { dmg: 3,  promo: 7,  ads: 12, tax: 12, cap: 12 } },
  beauty:  { key: 'beauty',  name: 'Beauty',         unitRet: 120, unitRto: 110, ret: 4,  rto: 9, life: '9-12 months',  lifeDays: 270, beta: -3,
             other: { dmg: 2,  promo: 5,  ads: 9,  tax: 6,  cap: 6 } },
  kids:    { key: 'kids',    name: 'Kids & baby',    unitRet: 200, unitRto: 160, ret: 10, rto: 8, life: '6-9 months',   lifeDays: 180, beta: -3,
             other: { dmg: 3,  promo: 6,  ads: 12, tax: 10, cap: 12 } },
  decor:   { key: 'decor',   name: 'Home decor',     unitRet: 230, unitRto: 180, ret: 9,  rto: 8, life: '12+ months',   lifeDays: 300, beta: -3,
             other: { dmg: 16, promo: 6,  ads: 8,  tax: 7,  cap: 4 }, dmgNote: '+6% breakage' },
};

/* ------------------------------------------------------------------ *
 * SKU LIBRARY  (deck slides 2, 3, 4, 5 - "SKU library" used in the deck)
 * price    : the seller's intended / offline price (day 0 hypothesis)
 * live     : price used in the prototype today
 * costs    : seller cost inputs, prefilled with category defaults
 * band     : look-alike band p25-p75 from the catalogue embeddings
 * ------------------------------------------------------------------ */
export const SKUS = {
  kurti: {
    key: 'kurti', name: 'Printed cotton kurti', short: 'Printed kurti', emoji: '👗', category: 'ethnic',
    price: 399, live: 369, band: [329, 429], median: 379, lookalikes: 24, closestRival: 299,
    recoveryFloorFallback: 283, lifeDays: 180, ordersAtLive: 23,
    costs: { cs: 180, pack: 10, fwd: 25, ret: 12, rto: 8, T: 60 },
    features: { fabric: 'cotton print', weightKg: 0.5, fragile: false, sizes: ['S', 'M', 'L', 'XL'] },
  },
  lunch: {
    key: 'lunch', name: 'Steel 3-tier lunch box', short: 'Steel lunch box', emoji: '🍱', category: 'kitchen',
    price: 449, live: 449, band: [379, 499], median: 439, lookalikes: 31, closestRival: 329,
    recoveryFloorFallback: 317, lifeDays: 360, ordersAtLive: 12,
    costs: { cs: 210, pack: 15, fwd: 45, ret: 5, rto: 7, T: 63 },
    features: { material: 'stainless steel', weightKg: 0.9, fragile: false, capacityL: 1.2 },
  },
  serum: {
    key: 'serum', name: 'Vitamin-C serum 30 ml', short: 'Vitamin-C serum', emoji: '🧴', category: 'beauty',
    price: 249, live: 249, band: [199, 299], median: 259, lookalikes: 40, closestRival: 159,
    recoveryFloorFallback: 152, lifeDays: 270, ordersAtLive: 30,
    costs: { cs: 90, pack: 8, fwd: 22, ret: 4, rto: 9, T: 33 },
    features: { volumeMl: 30, weightKg: 0.1, fragile: true, shelfLifeMonths: 18 },
  },
  romper: {
    key: 'romper', name: 'Baby romper, set of 3', short: 'Baby romper set', emoji: '👶', category: 'kids',
    price: 349, live: 349, band: [299, 399], median: 349, lookalikes: 28, closestRival: 249,
    recoveryFloorFallback: 244, lifeDays: 180, ordersAtLive: 18,
    costs: { cs: 150, pack: 10, fwd: 24, ret: 10, rto: 8, T: 53 },
    features: { ageBand: '0-12 months', weightKg: 0.35, fragile: false, safetyCert: true },
  },
  vase: {
    key: 'vase', name: 'Ceramic vase (fragile)', short: 'Ceramic vase', emoji: '🏺', category: 'decor',
    price: 499, live: 499, band: [449, 599], median: 519, lookalikes: 12, closestRival: 349,
    recoveryFloorFallback: 260, lifeDays: 300, ordersAtLive: 5.5,
    costs: { cs: 220, pack: 25, fwd: 40, ret: 9, rto: 8, T: 72 },
    features: { material: 'ceramic', weightKg: 1.4, fragile: true, handmade: true },
  },
};

export const SKU_IDS = Object.keys(SKUS);

/* ------------------------------------------------------------------ *
 * GOAL MODES  (deck slide 6 box 2)
 * ------------------------------------------------------------------ */
export const MODES = {
  cash:   { key: 'cash',   name: 'CASH',   emoji: '💸', color: '#2A7FC1',
            definition: 'Wants to reduce the wait to get cash from Meesho when products get sold.',
            objective: 'profit per rupee-day (profit / cash locked x days locked)' },
  growth: { key: 'growth', name: 'GROWTH', emoji: '🌱', color: '#1B8A5A',
            definition: 'OK to start with a small margin to get sales first, then increase slowly.',
            objective: 'profit per impression, after a volume-first launch' },
  margin: { key: 'margin', name: 'MARGIN', emoji: '🛡️', color: '#5B0A48',
            definition: 'Strict about margin.',
            objective: 'profit per impression, only arms with >= target profit per kept order' },
  clear:  { key: 'clear',  name: 'CLEAR',  emoji: '📦', color: '#D32F2F',
            definition: 'Wants to sell fast; margin is not important, but never below the cost.',
            objective: 'kept orders per impression (sell-through), never below floor F' },
};

/* ------------------------------------------------------------------ *
 * LIFECYCLE STAGES  (deck slides 4-5)
 * ------------------------------------------------------------------ */
export const STAGES = {
  launch:   { key: 'launch',   name: 'Launch',          color: '#2A7FC1', goal: 'Learn demand fast',
              signals: 'Impressions, CTR, CVR, first ratings', trigger: '>= 1,000 impressions or 14 days',
              move: 'Sanity check: buyers ordering, returns normal', defaultMode: 'Co-Pilot' },
  growth:   { key: 'growth',   name: 'Growth',          color: '#1B8A5A', goal: 'Scale what works',
              signals: 'Kept-unit growth vs last season, CVR vs similar SKUs, kept rate',
              trigger: '>= category kept rate, CVR holds 2 weeks after a step',
              move: 'Step up 3-5% or cut discount; Meesho widens reach (seller approves)', defaultMode: 'Co-Pilot -> Autopilot' },
  maturity: { key: 'maturity', name: 'Peak / Maturity', color: '#1F8F8A', goal: 'Protect margin',
              signals: 'Contribution per order, impression share, rival price gap',
              trigger: 'Rival undercuts > 5% for 7 days',
              move: 'Defend with costs and dual price, not deep cuts', defaultMode: 'Autopilot' },
  decline:  { key: 'decline',  name: 'Decline',         color: '#F58A0B', goal: 'Recover value',
              signals: 'Kept units vs last season, days of inventory, sell-through',
              trigger: 'Days of inventory > 60 or margin < 0',
              move: 'Bundles, wider reach (seller approves), steps >= full cost F', defaultMode: 'Co-Pilot' },
  exit:     { key: 'exit',     name: 'Clear / Exit',    color: '#D32F2F', goal: 'Free the cash',
              signals: 'Stock age, season end', trigger: 'Stock age > 90 days / season end',
              move: 'Clearance >= F; below F only with explicit consent', defaultMode: 'Co-Pilot + consent' },
};

export const STAGE_ORDER = ['launch', 'growth', 'maturity', 'decline', 'exit'];

/* Stage window defaults (deck slide 4 box 1/2): generic defaults, scaled per category.
   A 60-day-old kurti may already be mature; a 60-day-old lunch box is still launching. */
export const STAGE_WINDOWS_BASE = { launch: 30, growth: 60, maturity: 120, decline: 155, life: 180 };

/* ------------------------------------------------------------------ *
 * DIAGNOSTIC TREE  (deck slide 5 box 1/2) - checked before price, price last
 * ------------------------------------------------------------------ */
export const DIAGNOSE_NODES = [
  { key: 'views',  label: 'Views',       checks: 'Impressions vs similar products', rule: 'fires if < 50% of similar products, 2 weeks in a row', owner: 'seller',  fix: 'Better title, attributes, category mapping; ads or discount only after' },
  { key: 'clicks', label: 'Clicks (CTR)', checks: 'Thumbnail / title',               rule: 'fires if CTR z < -1.5, 2 weeks in a row',                 owner: 'seller',  fix: 'New main image, lifestyle photo, clearer price badge' },
  { key: 'conv',   label: 'Conversion',  checks: 'Price-value, page trust',          rule: 'fires if CVR z < -1.5 (needs >= 300 clicks)',            owner: 'seller',  fix: 'Price inside band -> page & trust fix: reviews, size chart, delivery promise' },
  { key: 'ret',    label: 'Returns',     checks: 'Size, quality, expectation',       rule: 'fires if returns > category + 5 pp',                     owner: 'seller',  fix: 'Size chart, quality check, true photos' },
  { key: 'rto',    label: 'RTO',         checks: 'COD refusals',                     rule: 'fires if RTO > category + 5 pp',                         owner: 'platform',fix: 'COD confirmation, prepaid nudge for risky pincodes' },
  { key: 'stock',  label: 'Stock',       checks: 'Days of inventory',                rule: 'fires if < 7 days or > 60 days',                         owner: 'seller',  fix: 'Replenish (reorder point) or free the cash (bundle / markdown ladder)' },
  { key: 'del',    label: 'Delivery',    checks: 'Dispatch speed',                   rule: 'fires if > category p75 delivery days',                  owner: 'platform',fix: 'Dispatch SLA, Valmo hub routing' },
  { key: 'price',  label: 'Price',       checks: 'Band position',                    rule: 'checked LAST; fires if outside the look-alike band',     owner: 'engine',  fix: 'Bounded test inside the band, or dual price' },
];

/* ------------------------------------------------------------------ *
 * LAUNCH PLAY MATRIX  (deck slide 3 box 2) - competition x stock
 * ------------------------------------------------------------------ */
export const LAUNCH_MATRIX = {
  priceDiscovery: { play: 'PRICE DISCOVERY', rule: 'Low competition + deep stock -> test higher prices, learn demand',
                    opening: 'open 5-8% above the median look-alike, rotate price menus on alternate days',
                    mode: 'Co-Pilot', step: '+4%' },
  velocity:       { play: 'VELOCITY',        rule: 'High competition + deep stock -> open just under the median, win reviews',
                    opening: 'open 2-3% under the median look-alike', mode: 'Co-Pilot', step: 'hold, then +3-5% after 30 orders' },
  controlled:     { play: 'CONTROLLED MARGIN', rule: 'Low competition + thin stock -> premium, no deep discounts',
                    opening: 'open at the upper band, hold', mode: 'Co-Pilot', step: 'no step until stock is replenished' },
  differentiate:  { play: 'DIFFERENTIATE OR SKIP', rule: 'High competition + thin stock -> bundle, better image, or skip',
                    opening: 'open at the median with the no-return price as the lead', mode: 'Manual', step: 'none; fix the listing first' },
};

/* ------------------------------------------------------------------ *
 * RETURN / RTO RISK MODEL defaults (deck slide 7 box 2, AUC >= 0.75)
 * ------------------------------------------------------------------ */
export const RISK_MODEL = {
  intercept: -2.35,
  weights: { sizeRisk: 0.55, codShare: 1.10, fragile: 0.60, weightKg: 0.35, categoryRet: 0.9, cityTier: 0.25, prepaidNudge: -0.45 },
  categoryReturnBase: { ethnic: 0.18, kitchen: 0.09, beauty: 0.08, kids: 0.14, decor: 0.11 },
  codFailureRate: 0.209,     // COD orders fail 20.9% vs prepaid 5.8% [Unicommerce] (slide 10)
  prepaidFailureRate: 0.058,
};

/* ------------------------------------------------------------------ *
 * PILOT / MEASUREMENT  (deck slide 8)
 * ------------------------------------------------------------------ */
export const PILOT = {
  cities: {
    surat:     { name: 'Surat',     category: 'ethnic wear',   sellers: 300, scores: { density: 5, fit: 5, tier: 3, ops: 4, returns: 5 }, note: '~40% of India\u2019s man-made fibre production; returns 18% -> hardest buffer test' },
    rajkot:    { name: 'Rajkot',    category: 'home & kitchen', sellers: 200, scores: { density: 4, fit: 5, tier: 4, ops: 4, returns: 3 }, note: '450-500 kitchenware units; bulky, slab-sensitive SKUs; returns 9% -> tests freight in the floor' },
    tiruppur:  { name: 'Tiruppur',  category: 'knitwear',      sellers: 0,   scores: { density: 4, fit: 3, tier: 4, ops: 3, returns: 4 }, note: 'backup' },
    moradabad: { name: 'Moradabad', category: 'metalware',     sellers: 0,   scores: { density: 3, fit: 4, tier: 5, ops: 3, returns: 3 }, note: '' },
    jaipur:    { name: 'Jaipur',    category: 'handicraft',    sellers: 0,   scores: { density: 3, fit: 4, tier: 3, ops: 3, returns: 4 }, note: '' },
  },
  cityWeights: { density: 0.30, fit: 0.25, tier: 0.15, ops: 0.15, returns: 0.15 },
  design: { treated: 250, holdout: 250, weeks: 12, randomise: 'seller', holdoutAfter: 0.05 },
  impact: {
    profitPerKeptOrder: { holdout: 84, treated: 104.5 },
    waterfall: [
      { label: 'Holdout baseline', value: 84, kind: 'base' },
      { label: 'Below-floor / under-priced SKUs fixed', value: 10 },
      { label: 'Growth steps +4% on 30% of SKUs', value: 4.5 },
      { label: 'Panic cuts avoided', value: 6 },
      { label: 'ProfitPilot', value: 104.5, kind: 'end' },
    ],
    keptOrders: {
      holdout: 28,
      chain: [
        { label: 'Holdout', value: 28, mult: 1 },
        { label: 'x 1.10 listing fixes', value: 30.8, mult: 1.10 },
        { label: 'x 1.08 dual price', value: 33.264, mult: 1.08 },
        { label: 'x 0.964 price-step elasticity', value: 32.067, mult: 0.964 },
        { label: 'x 84/82 kept-rate gain', value: 32.848, mult: 84 / 82 },
        { label: 'x 0.93 repricing up', value: 30.549, mult: 0.93 },
      ],
    },
    other: {
      returnRate: { from: 0.18, to: 0.155, drivers: ['-1.8 pp dual pricing (no-return buyers can\u2019t return)', '-0.7 pp size chart'] },
      belowFloorListings: { from: 'baseline (weeks 1-2)', to: '0%' },
      retention90d: { from: 0.50, to: 0.60 },
      costPerOrder: 'not claimed in 1.0',
    },
    sampleSize: { alpha: 1.96, power: 0.84, sigma: 40, delta: 10 },
    stopRules: [
      { rule: 'Floor accuracy off > +-5% vs settlement', action: 'recalibrate costs' },
      { rule: 'Acceptance < 20%', action: 'redesign cards' },
      { rule: 'Buyer conversion > 5% below holdout at a similar price', action: 'pause Autopilot' },
      { rule: 'Look-alike prices converge (herding)', action: 'widen dispersion' },
    ],
    cohort: {
      newSellers: 10000, activeWithout: 5000, activeWith: 6000,
      nmvPerSellerWithout: 131000, nmvPerSellerWith: 150000,
      cohortNmvWithout: 650000000, cohortNmvWith: 900000000,
    },
  },
};

/* ------------------------------------------------------------------ *
 * 2.0 PROGRAMMES  (deck slide 10 box 1) - rule-based routing inputs
 * ------------------------------------------------------------------ */
export const PROGRAMMES = {
  starterPack:     { key: 'STARTER_PACK',     name: 'Starter Pack',     trigger: 'No sales history yet',
                     kpi: 'first 10 kept orders in 30 days, vs holdout', fixes: [3, 7] },
  fastMovers:      { key: 'FAST_MOVERS',      name: 'Fast Movers',      trigger: 'Look-alikes high, demand stable',
                     kpi: 'stock-outs -20 to -30%', fixes: [4] },
  makerProgramme:  { key: 'MAKER_PROGRAMME',  name: 'Maker Programme',  trigger: 'Artisan score >= 0.7, few look-alikes',
                     kpi: 'higher price realised vs commodity', fixes: [8] },
  stockRecovery:   { key: 'STOCK_RECOVERY',   name: 'Stock Recovery',   trigger: 'Days of inventory > 60',
                     kpi: 'value recovered vs no action', fixes: [4, 7] },
  humanReview:     { key: 'HUMAN_REVIEW',     name: 'Human review',     trigger: 'Craft-like but many copies',
                     kpi: 'a person checks before a badge', fixes: [8] },
};

/* ------------------------------------------------------------------ *
 * LIMITS OF 1.0  (deck slide 9 box 1) - returned by /api/meta so the
 * product never over-claims, exactly like the deck says it should not.
 * ------------------------------------------------------------------ */
export const LIMITS = [
  { id: 1, limit: 'Few external signals', impact: 'High', note: 'suggestions rest on predictions mostly from internal data; little market, seasonal or offline demand', fix20: 'regional demand + event calendar' },
  { id: 2, limit: 'Prices move together', impact: 'Med',  note: 'look-alike prices converge (herding) -> widen dispersion, seller-specific floors, cap same-direction moves, legal review', fix20: 'causal uplift (M26), CLV (M25)' },
  { id: 3, limit: 'Generic to the seller', impact: 'Med', note: 'capital, risk appetite and capacity only partly used', fix20: 'seller profile + credit (M30)' },
  { id: 4, limit: 'Execution gaps', impact: 'Med',       note: 'supply, lead times and cash flow not checked', fix20: 'reorder point (M28), pooling (M29)' },
  { id: 5, limit: 'Weak closed loop', impact: 'Low',     note: 'we do not always know which advice was applied', fix20: 'action tracking + AI coach' },
  { id: 6, limit: 'Short-term metrics', impact: 'High',  note: 'orders / GMV over survival and repeat seasons', fix20: 'CLV objective (M25)' },
  { id: 7, limit: 'Isolated from ecosystem', impact: 'Low', note: 'suppliers, credit, logistics not wired in', fix20: 'four programmes (slide 10)' },
  { id: 8, limit: 'Thin category context', impact: 'Med', note: 'regional, event and category nuances missing', fix20: 'category packs, review intelligence' },
];

/* Which endpoints map to which deck slide - served at GET /api/meta so the
   frontend can print "Deck 2-3 - Economics, Launch" style tags. */
export const PROVENANCE = {
  '/api/skus': 'Deck 2 box 1 - the SKU library',
  '/api/listings/:id/floor': 'Deck 2 box 2 + M4/M6 - the return-adjusted floor',
  '/api/listings/:id/floor/sensitivity': 'Deck 2 box 2 - floor sensitivity levers',
  '/api/launch/plan': 'Deck 3 - the cold-start path and the launch-play matrix',
  '/api/listings/:id/recommendation': 'Deck 6 - ProfitPilot: two numbers required, a dual price out',
  '/api/listings/:id/diagnose': 'Deck 5 - diagnose before you discount (8-node scan)',
  '/api/listings/:id/lifecycle': 'Deck 4 - re-decide the price at every trigger',
  '/api/engine/bandit/run': 'Deck 7 box 4 - price search that cannot lose money',
  '/api/pilot/*': 'Deck 8 - pilot, impact and metrics',
  '/api/coach/ask': 'Deck 6 + 10 - the AI coach answers with sources',
  '/api/decisions': 'Deck 9 limit 5 - action tracking (weak closed loop)',
  '/api/programmes/route': 'Deck 10 - ProfitPilot 2.0 programme routing',
};

export const SERVICE = {
  name: 'profitpilot-backend',
  version: '1.0.0',
  engine: 'ProfitPilot 1.0',
  deck: 'Meesho DICE Challenge S3 - Business Track - Team Fiery Diamonds (IIT Madras)',
  banner: 'All numbers are simulated or planning defaults from the deck. Nothing here is real Meesho data.',
};
