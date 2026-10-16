# Retained measurements for the FGCS manuscript

These files preserve the completed campaigns measured on 15 October 2026.
They accompany release `fgcs-artifact-v1.1.0`. They are observations from the
reported implementation and environment, not results newly measured during
artifact packaging. Earlier WAN campaigns are not mixed into this dataset.

## Recalculate without external services

From the repository root, using Python 3.9 or later (standard library only):

```sh
python scripts/recalculate_paper.py --output tmp/paper-statistics.json
```

The command checks the SHA-256 inventory, recalculates all 219 non-throughput
summary rows, checks 13 local aggregate measurement windows, regenerates the
90,000 seeded arrivals, and derives the Table 5 residual from five paired
rounds. It also exports the plotted values and table data in the JSON report.
It does not execute benchmarks, connect to a blockchain, or call a model API.

## Mapping to the manuscript

| Evidence | Files | Use |
| --- | --- | --- |
| 1,090 local invocations; 130 warm-ups | `local/protocol_raw.jsonl`, matching summaries | Abstract, Section 6.2.1, Figure 2(a), local throughput |
| 40 proofs; 4 warm-ups | `local/zk_raw.jsonl`, matching summaries | Section 6.3, Table 3; witness and verification times are distinct |
| 18 seeded batching settings, 5,000 arrivals each | `local/campaign_config.json`, `batch_policy_summary.json` | Section 6.3; exact input stream regenerated from the seed |
| 400 relay-recovery rounds; 20 warm-ups | `fault-gas/fault_raw.jsonl`, matching summaries | Section 6.5, Table 6 |
| 104 local transactions/deployments | `fault-gas/local_gas_raw.jsonl`, matching summaries | Section 6.4, withdrawal/release cost |
| 128 derived policy rows from 16 matched component repetitions | `fault-gas/gas_policy_baseline_raw.jsonl`, summaries and comparisons | Table 4 and 22.34% amortization; these are not 128 additional transactions |
| 10 paid model calls; 1 warm-up | `llm/real_llm_raw.jsonl`, matching summaries | Section 6.2.2, Figure 2(b) |
| 1,040 WAN records; 106 warm-ups | `wan/wan_raw.jsonl`, matching summaries | Sections 6.2.3 and 6.5, Figure 3; includes transport, protocol and recovery records |
| 5 public-testnet rounds; 1 warm-up | `testnet/testnet_v2_raw.jsonl`, matching summaries | Section 6.4, Table 5 |
| One unused-root withdrawal sequence | `testnet/withdrawal_public_testnet.jsonl` | Section 6.4; five confirmed transactions, including setup |
| ProVerif, bounded state exploration and correctness results | `verification/` | Table 1, Sections 5.3 and 6.1.1; preserved execution reports, not independent verification |

Table 2 describes these campaign counts. Table 7 is a qualitative comparison,
and Figure 1 is an architectural diagram; neither has an underlying measurement
dataset. The paper's main protocol, circuit and formal-model sources are listed
in `docs/SOURCE_PROVENANCE.json` at the repository root.

## Statistics and units

- A JSONL line is one record. Keep all records in the archive and exclude
  `warmup: true` only when computing reported statistics. There is no post hoc
  outlier filtering. Gas observations and derived Gas-policy rows have no
  warm-up field and are all retained.
- `*Ms` fields are milliseconds; the tables convert selected values to seconds.
  Gas is an execution-unit count, not a currency amount. Payload sizes are bytes.
- Percentiles use linear interpolation at rank `(n - 1) * p`, where `p` is in
  `[0, 1]`. Standard deviation uses divisor `n - 1`.
- Original `ci95` fields use `mean +/- 1.96 * sample_sd / sqrt(n)`. These normal
  approximations do not establish small-sample coverage. The paper reports means
  and selected descriptive percentiles, not a universal population-tail claim.
- Throughput is completed calls divided by the whole measured window, not the
  inverse of mean latency. Legacy throughput rows repeat one aggregate in their
  percentile/CI columns; those fields are not a sampling distribution or an
  uncertainty interval. The WAN row's `count` is the number of completed calls.

## Table 5: timing boundaries

For each of the five non-warm-up rounds, the residual in seconds is:

```text
(endToEndMs - proveMs - registerBatchFinalityMs
 - relayAcceptFinalityMs - settleFinalityMs) / 1000
```

The total mean is 133.05813366 s. The four component means sum to 98.28080108 s;
the residual mean is 34.77733258 s (reported as 34.78 s), and the percentile of
the five residuals is 55.15500025 s (reported as 55.16 s). Each displayed table
value is rounded independently. Percentiles are not additive.

The three chain timers begin after the transaction-submission call returns.
The enclosing registration-to-settlement timer starts before submission and
includes intervening contract queries and receipt signatures. The residual
therefore covers preparation/submission and inter-stage coordination. It is
derived, not separately instrumented; individual RPC, retry and signing costs
cannot be reconstructed. Testnet `proveMs` includes witness generation through
`fullProve`, while the local `zk` campaign records witness generation separately.
The enclosing total excludes input construction, off-chain proof verification,
and conversion to contract arguments. See `scripts/v2/benchmark_testnet_v2.js`.

## WAN archival limit

The original WAN driver retained per-call latency, a shared `chunkElapsedMs`
for each concurrently executed group, and final aggregate goodput. It did not
serialize the complete-window `measuredElapsedMs` used in the denominator.
Consequently, the original goodput is available as a measured aggregate, but
its exact denominator cannot be independently reconstructed from this archive.
The local campaign does retain its full-window times.

The recalculation report keeps the WAN aggregate unchanged and checks it
against the sum of recorded serial chunks. It labels `impliedWindowMs`
explicitly as algebraically inferred; this is not a recovered raw observation
or an independent validation of goodput. The implied interval outside chunks
is 0.69--4.86 ms across the eight settings. Replacing the full window with the
chunk sum or with inverse mean latency would change the metric.

For future runs, the driver now writes `wan_setting_reports.json` after all
timed work finishes, preserving the full-window denominator. This persistence
addition neither fills the missing historical timer nor changes the reported
measurement values or the timed protocol code.

## Provenance and sanitization

`manifest.json` records the published hash, source hash and transformation for
each file. All numerical observations, order and warm-up flags are retained.
Only API `responseId` values were removed from model records. WAN endpoint and
account/path details are placeholders in the archived configuration. Campaign
metadata are explicitly selected from the original manifests. Public transaction
hashes and contract addresses are retained to support chain-level inspection.
No private keys, API credentials, SSH credentials or private environment files
are distributed. Historical hashes identify the archived source; they are not
claims that a sanitized file is byte-identical to its private original.

The simulation input stream is generated by the supplied seeded algorithm;
there is no separately collected external input dataset. Model prompts and
synthetic protocol inputs are generated by the experiment drivers. Live reruns
require the resources described in `docs/EXTERNAL_EXPERIMENTS.md`, and their
timings will depend on the new environment.
