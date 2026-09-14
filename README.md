# new-product-rsi — A Self-Iterating "Product Selection World Model" Experiment

**RSI** = **R**e**S**earch-**I**ndex: a research workflow that periodically runs an investigation, then slows down (gradually flattens) as it converges — "research, then a slowing index." Each iteration widens the view, and the rate of new learning tapers as the system settles on a stable strategy.

> 🇨🇳 中文版见 [README.zh-CN.md](./README.zh-CN.md)

This repo is a **world-model experiment**: the product-selection business of a cross-border e-commerce platform is built as a **simulatable, back-propagatable, continuously-tunable business computation graph**. It is a small, self-contained RL loop — the environment holds a fixed set of rules, the **reward is the 7-day zero-sales-break rate**, and we iteratively tune the two places on the chain we are allowed to touch.

> ⚠️ **This is a validation experiment, not a production system.** It answers exactly one question: can "run the chain forward → read the zero-break rate → back-propagate along the chain → adjust strategy → re-run" keep pushing the zero-break rate up?

## The idea in one sentence

Build product selection as a computational graph that can be **simulated, back-propagated, and continuously adjusted** — a form of reinforcement learning. The environment follows fixed laws; the reward is the **7-day zero-break rate** (fraction of dispatched packages that sold ≥ 5 units within 7 days); we tune whatever the chain lets us tune. The zero-break rate is the joint outcome of *selection quality × merchant adoption × incentive policy* — it is not decided by any single step.

## The business being simulated

A hot hero product (**`google fitbit air`**) creates demand for its accessories. Each round the platform:

1. **Picks candidates** — layered-randomly draws 8 of 24 accessory clusters (3 "push", 2 "ambiguous", 3 "don't push", seeded by round number; the optimizer never sees this stratification).
2. **① Product selection** *(optimizable)* — for each candidate cluster, reads three datasets and judges whether it is a future star.
3. **② Price incentive** *(optimizable)* — decides subsidy + merchant-facing pitch for pushed clusters; **ROI is hard-capped** at 0.3 × competitor median price band.
4. **③ Dispatch** *(fixed)* — packages cards + incentives and broadcasts to merchants.
5. **④ Merchant decision** *(environment, fixed)* — each merchant, per its persona, decides to publish or not. Trust (the only runtime-mutable state) rises/falls after settlement.
6. **⑤ Consumer purchase** *(environment, fixed)* — 5 consumer groups compute 7-day sales: scripted baseline × LLM taste/price coefficient.
7. **Settlement** — computes the **zero-break rate** (published products with ≥ `ZERO_BREAK_THRESHOLD`=5 units in 7 days ÷ dispatched packages) and updates merchant trust in place.

Then **self-iteration** reviews the rounds that ran (business-visible data only — no ground truth, no personas, no merchant inner thoughts), and produces the next round's parameter package: updated **judgment experience** entries and **incentive prompt** policies. Rounds are version-bound: `runs/rN` is produced by `opt_points/rN`.

### The main chain (see `spec/ontology.png`)

```
hero item ──▶ accessory clusters ──▶ on-site / off-site sales, off-site demand
   │                                        │
   └──▶ ① selection card ──▶ ② incentive ──▶ ③ dispatch_package ──▶ ④ merchant ──▶ ⑤ product sales
                                                                                        │
                                                                   7-day zero-break rate ◀──┘ (reward)
```

## Key concepts

| Term | Meaning |
|---|---|
| **Ontology** | The world's nouns: hero item, accessory cluster, three market datasets, selection card, incentive, dispatch package, merchant, product, consumer group — plus the **business influence relations** that connect them (per `spec/ontology.md`). |
| **Action** | A step with input→output contract. Two optimizable business/system actions (selection, incentive), one fixed dispatch, two environment actions (merchant, consumer). |
| **Business map** | Scene-specific knowledge: the "3C consumer electronics – hero-product accessories" scene and its judgment-experience entries (the minimal unit self-iteration edits). |
| **Environment** | Fixed world rules: merchant personas (type / top categories / monthly GMV / trust), consumer-group personas, and data. Immutable during a run. |
| **God view** | `spec/ontology_god.md` + `data/_ground_truth.json` — the experiment's internal design (how data is fabricated, traps, personas). Never fed into the optimization loop; a visibility scan guards the leak. |

## Repository layout

```
spec/                  Design docs (system architecture, ontology, business map, main chain, god view)
draf/                  Design thinking & consensus notes
app/
  ontology/            Object schema definitions (declarative; validation derives from them)
  flow/                run_round · self_iterate (DFS-pruning) · attribution (checkpoint layer) · improvement_ledger · replay (diagnostic) · report · analyze · checks · reset
  action/              abstract (interface contracts) · system · business · env (merchants, consumer groups)
  llm/                 qodercli adapter — the single exit for every LLM call
  lib/                 Shared utils (Beijing-time, constants, ontology context, market/competitor price-band)
  scene/               Scene assets: business map + symlinked judgment experience
  data/                Hero item, clusters, the three datasets (+ generate.js, ground truth)
  runs/rN/             Execution artifacts: snap_0..snap_6 + logs + attribution.json (attribution checkpoint), one dir per round
  opt_points/          Optimizable points: init/ + per-round parameter packages rN/
```

## Requirements

- **Node.js ≥ 18** (plain ESM, no build step, no dependencies — only built-in `node:fs` / `node:path` / `node:child_process`)
- **`qodercli`** on `PATH` — every LLM call spawns `qodercli -p "<prompt>" --output-format stream-json --dangerously-skip-permissions` (no session, no cache, real call each time). All timestamps are Beijing time.

## Usage

```bash
# Run a round (uses opt_points/rN if present, else init; add --force to re-run)
node app/flow/run_round.js r1

# Self-iterate: review rounds up to rN, produce opt_points/rN+1
node app/flow/self_iterate.js r1

# Generate the experiment report (god-view review, needs --fresh to re-analyze)
node app/flow/report.js --fresh

# Dev reset: wipe runs/ and opt_points/rN, restore merchant trust to trust_init
node app/flow/reset.js
```

### A typical loop

```bash
node app/flow/run_round.js r1    # run the first round
node app/flow/self_iterate.js r1 # review r1 → produce opt_points/r2
node app/flow/run_round.js r2    # run with the new parameter package
# ... repeat ...
node app/flow/report.js --fresh  # god-view report on all rounds
```

## Attribution checkpoint layer (why self-iteration is DFS pruning)

Since self-iteration started, break-zero counts were stuck at 1–2 across r1–r5 — most of the time not because the strategy was wrong, but because one noisy break-zero figure was being blamed on a whole long chain (which cluster → subsidy → merchant price → noise → break). So `self_iterate.js` was rewritten to **prune the attribution chain short**: `run_round.js` computes a deterministic, business-visible checkpoint per round (`runs/rN/attribution.json`) that locates each non-breaking cluster to one segment — `broke / merchant_not_publish / pricing_dead / pricing / demand`. Self-iteration then only re-derives the narrow `demand` (需求/用户群匹配) space left over, and never re-derives an excluded segment. Full rationale & guardrails: `spec/选品自迭代改进_讨论汇总.md` + the code header comments in `app/flow/attribution.js` / `improvement_ledger.js` / `replay.js`.

**Anti-cheat firewall (verbatim, unchanged):** the checkpoint, ledger and replay tool use only business-visible fields (pay / in-band / observed sales / per-group sales / publishing behavior) — never `_ground_truth.json`, `trust`, merchant `why`, consumer personas, or god-view alerts. `checks.js` runs a leak scan on these files. Literal replay is a god-view diagnostic for humans only, never consumed by the optimization loop (convicting its entries would require the truth value = leak).

## The two optimizable points (everything else is code-fixed)

1. **Judgment experience** — how to read the three datasets and decide what to push (`opt_points/<round>/judgment_experience.md`, ≤ 8 entries, E-numbered). Self-iteration edits copies in `opt_points/rN`, never `init/`.
2. **Incentive policy** — how deep to subsidize and what tone to pitch (`opt_points/<round>/incentive_prompt.md`). Hard constraint: subsidy ≤ 0.3 × competitor price-band median; output format is fixed.

**Red lines:** environment (data, personas) is frozen during a run; self-iteration only tunes the two points above and never sees the god view; output formats and the ROI cap are hard-coded.

## Documentation

- `spec/app_design.md` — experiment design (four layers, main chain, self-iteration rules)
- `spec/main_link.md` — the main chain, action by action, with optimization/constraint specs
- `spec/ontology.md` — business-view ontology (safe to feed to the LLM)
- `spec/ontology_god.md` — god-view internals (NEVER fed to the optimization loop)
- `spec/business_map.md` — the scene's judgment experience entries
