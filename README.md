# zk-CrossAgent

Reproduction artifact for **zk-CrossAgent: Task-Bounded Authorization and Cross-Chain
Settlement for Autonomous AI Agents**.

This repository contains the protocol implementation, smart contracts,
zero-knowledge circuit, formal models, automated tests, and experiment drivers.
Release **`fgcs-artifact-v1.1.0`** also includes the retained measurements,
statistical summaries, campaign configurations and verification reports used
by the manuscript. A standard-library Python script recalculates the numerical
summaries without external services. WAN goodput is retained as an aggregate;
its original full-window timer was not separately archived, as documented in
the [dataset README](data/measurement-20261015/README.md). Independent benchmark
reruns create new observations and do not guarantee identical timing results.

To inspect the reported statistics without installing Node.js dependencies:

```sh
python scripts/recalculate_paper.py --output tmp/paper-statistics.json
```

## Contents

| Directory | Purpose |
| --- | --- |
| `lib/` | Authorization, committed delivery, persistent state, relaying, and unused-budget release |
| `contracts/v2/` | Capability and batch registries, receipt settlement, withdrawal, and Groth16 verification |
| `circuits/v2/` | Circom source; build products and proving parameters are generated locally |
| `formal/` | ProVerif authentication model and explicit state model |
| `test/` | Automated protocol, contract, recovery, and verifier tests |
| `scripts/v2/` | Experiment and verification implementations |
| `experiments/v2/configs/` | Sample counts, workloads, and confirmation settings |
| `scripts/wan/` | Two-host launch support and metadata caching before timing |
| `data/measurement-20261015/` | Retained measurements, hashes, methodology and table/figure mapping |
| `scripts/recalculate_paper.py` | Offline statistical recalculation and consistency checks |

## Environment

The documented reproduction target is Linux x86-64 with Node.js **20.20.1** and
npm. Use `npm ci` to install the versions recorded in `package-lock.json`.
The measured coordinator used Linux 5.15 and an Intel Xeon Platinum 8470Q;
the reported host CPU count does not represent dedicated experimental cores.
A GPU and model weights are not required: the model-service experiment uses an API.

Additional tools are needed only for the corresponding workflows:

- Circom 2.2.0 or later on `PATH`, built from a pinned release; record `circom --version`.
  The circuit declares its required language version in its first line.
- ProVerif **2.05** installed in an opam switch. The formal runner invokes
  `opam exec -- proverif`.
- A C/C++ build toolchain and Python 3 if the platform needs to build `better-sqlite3`.
- OpenSSH and `ping` for the two-host WAN experiment.
- Optional Python 3 and matplotlib for plotting newly generated measurements.

Install dependencies from the repository root:

```sh
nvm install
nvm use
npm ci
cp .env.example .env
npm run repro:environment
```

The original dependency resolutions are retained. The packaging changes do not
update the protocol dependencies or alter the workload sizes.

## Start with local checks

```sh
npm run compile
npm run test:unit
npm run repro:state
```

`test:unit` runs the tests that do not require circuit build products or a generated
Groth16 proof. It excludes the batch-registry, deadline-settlement, and verifier
test files. It is a subset of `npm test`; excluded tests are not counted as passes.

For the symbolic verification:

```sh
opam install proverif.2.05
npm run repro:formal
```

The formal runner checks all queries and then runs the state model. Its output is
written under `formal/evidence/`, which is excluded from version control.

## Build the circuit and proof fixtures

Download the published Powers of Tau transcript to the following path, or set
`PTAU_PATH` to an existing copy:

```sh
mkdir -p circuits/v2/setup
curl --fail --location --retry 3 \
  https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_19.ptau \
  --output circuits/v2/setup/powersOfTau28_hez_final_19.ptau
npm run repro:bootstrap
npm test
npm run repro:circuit
```

The bootstrap compiles the circuit with `--O2`, verifies the published transcript
and its embedded BLAKE2b-512 digest, creates a fresh circuit-specific Groth16 setup,
exports the matching Solidity verifier, generates proof/test inputs, and compiles
the contracts. Setup and proving need substantial CPU, RAM, and temporary disk;
this is not a lightweight installation step. No fixed completion time or minimum
memory has been validated for arbitrary reviewer machines.

Fresh setup uses new randomness, so the generated keys, proofs, verifier constants,
and their hashes differ from the authors' setup. All must be generated together.
The circuit relation is unchanged. This prototype setup is not a production
multi-party ceremony.

The verifier is a tracked source file. Before deploying to a public test network,
commit the locally generated verifier so that the deployment's clean-worktree
check can record the actual version:

```sh
git add contracts/v2/generated/ZkCrossAgentBatchVerifierV2.sol
git commit -m "Record verifier generated for this reproduction"
```

Configure a local Git identity if needed. A downloaded ZIP can be used for local
tests; a Git checkout is recommended for deployment and version recording.

## Reproduce experiments

After bootstrap, run the full local workloads:

```sh
npm run repro:local
```

This runs protocol latency and concurrency, synthetic delay and payload sweeps,
batch-policy analysis, Groth16 proving, process-fault recovery, on-chain Gas
measurements on Hardhat, and matched Gas-policy calculations. Result files are
written under `experiments/v2/results/reproduction-local/` and
`experiments/v2/results/reproduction-fault-gas/`.

See [the external experiment instructions](docs/EXTERNAL_EXPERIMENTS.md) for:

- geographically separated WAN execution;
- the DeepSeek model-service request experiment;
- Polygon Amoy/Sepolia deployment, confirmation timing, settlement, and withdrawal.

Those experiments require the reviewer's own hosts, credentials, working RPC
services, and funded testnet accounts. No external experiment is enabled by default.
Synthetic local delay is not a replacement for a geographical WAN run.

Each benchmark writes raw samples and mean/percentile summaries. Warm-up handling
and sample counts are specified in the configuration and benchmark implementation.
Latency, throughput, remote-model response time, and public-chain confirmation
time depend on the environment. Independent reruns do not guarantee the exact
numbers reported in the manuscript. Failed or interrupted runs should be preserved
locally and identified as such, rather than merged silently into completed runs.

To plot the newly generated local/WAN summaries, install matplotlib in your own
Python environment and run:

```sh
python scripts/plot_results.py --local experiments/v2/results/reproduction-local
python scripts/plot_results.py --wan experiments/v2/results/reproduction-wan
```

These plots visualize the rerun; they are not copies of the manuscript's figures.

## Scope of availability

This release includes code and the documented measurement archive. The source
inventory and packaging changes are recorded in `docs/SOURCE_PROVENANCE.json`;
data transformations and hashes are in `data/measurement-20261015/manifest.json`.
Secrets, private endpoint configuration and bulky regenerable build artifacts
are omitted. New benchmark results remain ignored by Git; the published archive
is kept in a separate read-only analysis location.

No open-source license has been assigned. The existing `UNLICENSED` designation
is retained; public visibility alone does not grant an open-source license.
