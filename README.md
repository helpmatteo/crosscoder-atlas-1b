# 1B Crosscoder Atlas

Interactive feature atlas for a parameter-trajectory crosscoder trained on 32 Pythia-1B unembedding-matrix snapshots (steps 0 → 143,000). Companion artifact for *How Vocabulary Readouts Reorganize During Pretraining*.

**Live site:** https://helpmatteo.github.io/crosscoder-atlas-1b/

## What's in the atlas

- **Table view:** all 24,576 sparse-dictionary features. Default sort is `Δ‖·‖ across step 1k` — the per-feature change in decoder-norm pre- vs post-step-1000 (the paper's central transition window).
- **Per-feature page:** decoder-norm / activation-rate / direction / rotation trajectories with the [256, 1000] window shaded; top promoted tokens at five snapshots (init, warmup, early, transition, terminal); ten nearest neighbors by cosine.
- **Examples tab:** 39 curated features grouped by lifecycle pattern — discourse markers, multilingual scripts, math/LaTeX, decade-specialized year features, semantic concept clusters, code/markup syntax.

## How to read

- A feature is a shared sparse direction across all 32 checkpoints. Decoder-norm at snapshot *s* is interpretable as "how strongly checkpoint *s* uses this feature." Decoder-direction rotation between adjacent snapshots tells you whether the readout direction is moving.
- Top promoted tokens at snapshot *s* = vocabulary rows with highest dot product against the feature's decoder direction at *s*, projected through that snapshot's W_U.
- Sparse dictionaries are not identifiable at the feature-ID level across seeds; treat the atlas as a population view, not a catalog of seed-stable atoms.

## Run locally

```bash
git clone https://github.com/helpmatteo/crosscoder-atlas-1b.git
cd crosscoder-atlas-1b
python -m http.server 8765
# open http://localhost:8765/
```

## Data

`data/index.json` holds per-feature scalars and the snapshot schedule. `data/shards/feat_*.json` (48 shards × 512 features) hold trajectories and top-token lists. CSV sidecars (`data/feature_table.csv`, `data/top_tokens_terminal.csv`) carry the same numbers in flat form.
