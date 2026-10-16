#!/usr/bin/env python3
"""Audit the retained measurements and recalculate paper statistics (stdlib only).

No network, wallet, model API, or benchmark execution is involved. Original
observations are read-only. Use --output PATH to save the derived report.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data/measurement-20261015'


def read(name):
    return json.loads((DATA / name).read_text(encoding='utf-8'))


def rows(name):
    return [json.loads(line) for line in (DATA / name).read_text(encoding='utf-8').splitlines() if line.strip()]


def measured(values):
    return [row for row in values if not row.get('warmup', False)]


def stats(values):
    values = [v for v in values if isinstance(v, (int, float)) and math.isfinite(v)]
    assert values, 'No numeric observations'
    ordered = sorted(values)
    count = len(values)
    mean = sum(values) / count
    sd = math.sqrt(sum((x - mean) ** 2 for x in values) / (count - 1)) if count > 1 else 0

    def percentile(p):
        rank = p * (count - 1)
        lo, hi = math.floor(rank), math.ceil(rank)
        return ordered[lo] + (ordered[hi] - ordered[lo]) * (rank - lo)

    half = 1.96 * sd / math.sqrt(count)
    return {'count': count, 'mean': mean, 'stddev': sd, 'ci95': [mean - half, mean + half],
            'p50': percentile(.50), 'p95': percentile(.95), 'p99': percentile(.99),
            'min': min(values), 'max': max(values)}


def equal(actual, expected, label):
    if isinstance(expected, list):
        assert len(actual) == len(expected), label
        for i, (a, e) in enumerate(zip(actual, expected)):
            equal(a, e, f'{label}[{i}]')
    else:
        assert math.isclose(actual, expected, rel_tol=1e-9, abs_tol=1e-7), (label, actual, expected)


def one(values, **filters):
    found = [r for r in values if all(r.get(k) == v for k, v in filters.items())]
    assert len(found) == 1, filters
    return found[0]


def verify_summary(raw, summary, keys):
    checked = 0
    for expected in summary:
        if expected['metric'] == 'throughputOpsPerSecond':
            continue  # Aggregate measurement windows need their own treatment.
        selected = [r for r in measured(raw) if all(r.get(k) == expected.get(k) for k in keys)]
        actual = stats([r.get(expected['metric']) for r in selected])
        for key, value in actual.items():
            equal(value, expected[key], expected['metric'] + '/' + key)
        checked += 1
    return checked


def verify_batch_policy(config, expected):
    state = config['randomSeed'] & 0xffffffff

    def random():
        nonlocal state
        state = (1664525 * state + 1013904223) & 0xffffffff
        return state / 4294967296

    for setting in expected:
        arrivals = []
        time = 0
        for _ in range(config['batchPolicy']['arrivalsPerSetting']):
            time += -math.log(max(random(), 2 ** -52)) / setting['arrivalRatePerSecond'] * 1000
            arrivals.append(time)
        waits, pending = [], []
        batches = dummy = 0

        def flush(at):
            nonlocal batches, dummy, pending
            waits.extend(at - t for t in pending)
            batches += 1
            dummy += setting['batchSize'] - len(pending)
            pending = []

        for at in arrivals:
            if pending and at > pending[0] + setting['timeoutMs']:
                flush(pending[0] + setting['timeoutMs'])
            pending.append(at)
            if len(pending) == setting['batchSize']:
                flush(at)
        if pending:
            flush(pending[0] + setting['timeoutMs'])
        for key, value in {'arrivals': len(arrivals), 'batches': batches, 'dummySlots': dummy,
                           'dummyRatio': dummy / (batches * setting['batchSize']),
                           'meanFill': len(arrivals) / batches}.items():
            equal(value, setting[key], 'batch/' + key)
        for key, value in stats(waits).items():
            equal(value, setting['waitMs'][key], 'batch/waitMs/' + key)


def audit():
    manifest = read('manifest.json')
    for entry in manifest['files']:
        body = (DATA / entry['path']).read_bytes()
        assert len(body) == entry['sizeBytes'], entry['path']
        assert hashlib.sha256(body).hexdigest() == entry['sha256'], entry['path']

    specs = [
        ('local/protocol', ['scenario', 'settingId', 'ablation']),
        ('local/zk', ['realCount']),
        ('fault-gas/fault', ['scenario']),
        ('fault-gas/local_gas', ['operation']),
        ('fault-gas/gas_policy_baseline', ['policy', 'realCount']),
        ('llm/real_llm', ['scenario', 'settingId', 'ablation']),
        ('wan/wan', ['recordType', 'transportMode', 'concurrency']),
        ('testnet/testnet_v2', []),
    ]
    raw, summaries, counts = {}, {}, {}
    summary_count = 0
    for name, keys in specs:
        raw[name], summaries[name] = rows(name + '_raw.jsonl'), read(name + '_summary.json')
        counts[name] = {'total': len(raw[name]), 'measured': len(measured(raw[name])),
                        'warmups': sum(bool(r.get('warmup')) for r in raw[name])}
        summary_count += verify_summary(raw[name], summaries[name], keys)
        for row in raw[name]:
            if 'outcome' in row:
                assert row['outcome'] == 'success', (name, row)
            if 'verified' in row:
                assert row['verified'] is True, (name, row)

    local_windows = []
    for expected in summaries['local/protocol']:
        if expected['metric'] != 'throughputOpsPerSecond':
            continue
        selected = [r for r in measured(raw['local/protocol']) if r['settingId'] == expected['settingId']]
        equal(len(selected), expected['measuredSamples'], 'local window count')
        goodput = len(selected) * 1000 / expected['measuredElapsedMs']
        equal(goodput, expected['mean'], 'local goodput')
        local_windows.append({'settingId': expected['settingId'], 'measuredElapsedMs': expected['measuredElapsedMs'],
                              'measuredSamples': len(selected), 'goodput': goodput})

    wan_windows = []
    for expected in summaries['wan/wan']:
        if expected['metric'] != 'throughputOpsPerSecond':
            continue
        selected = [r for r in measured(raw['wan/wan']) if r['recordType'] == expected['recordType']
                    and r['transportMode'] == expected['transportMode'] and r['concurrency'] == expected['concurrency']]
        c = expected['concurrency']
        equal(len(selected), expected['count'], 'WAN completed count')
        chunks = []
        for offset in range(0, len(selected), c):
            group = selected[offset:offset + c]
            assert len({r['chunkElapsedMs'] for r in group}) == 1, 'Inconsistent WAN chunk timer'
            chunks.append(group[0]['chunkElapsedMs'])
        chunk_sum = sum(chunks)
        # The aggregate is retained; its original timer was not serialized.
        # This implied duration is an algebraic consistency check, not a recovered observation.
        implied = len(selected) * 1000 / expected['mean']
        assert implied >= chunk_sum, 'Aggregate duration cannot be shorter than its serial chunks'
        wan_windows.append({'transportMode': expected['transportMode'], 'concurrency': c,
                            'completedCalls': len(selected), 'retainedGoodput': expected['mean'],
                            'sumRecordedChunkMs': chunk_sum, 'impliedWindowMs': implied,
                            'impliedInterChunkOverheadMs': implied - chunk_sum,
                            'independentWindowRecalculationAvailable': False})

    batch = read('local/batch_policy_summary.json')
    verify_batch_policy(read('local/campaign_config.json'), batch)

    policies = raw['fault-gas/gas_policy_baseline']
    components = raw['fault-gas/local_gas']
    for r in policies:
        equal(r['gasPerReceipt'], r['settlementGas'] + (r['batchRootGas'] + r['verifierGas']) / r['realCount'], 'derived gas')
        equal(r['settlementGas'], one(components, operation='settle_receipt', round=r['round'])['gasUsed'], 'settlement component')
        equal(r['batchRootGas'], one(components, operation='accept_batch_root', round=r['round'])['gasUsed'], 'root component')
        if r['policy'] == 'non_zk_batch_amortized':
            assert r['verifierGas'] == 0
        else:
            verify_gas = [x['gasUsed'] for x in components if x['operation'] == 'verify_groth16_batch']
            equal(r['verifierGas'], verify_gas[r['round'] - 1], 'verifier component')
    for r in read('fault-gas/gas_policy_comparisons.json'):
        numerator = one(summaries['fault-gas/gas_policy_baseline'],
                        policy=r['numeratorPolicy'], realCount=r['numeratorRealCount'])['mean']
        denominator = one(summaries['fault-gas/gas_policy_baseline'],
                          policy=r['denominatorPolicy'], realCount=r['denominatorRealCount'])['mean']
        equal((numerator - denominator) / denominator, r['relativeChange'], 'Gas-policy comparison')
    for r in measured(raw['fault-gas/fault']):
        assert r['destinationApplications'] == 1, 'Duplicate or missing transition'

    testnet = measured(raw['testnet/testnet_v2'])
    residual = []
    for r in testnet:
        components_ms = sum(r[key] for key in ['proveMs', 'registerBatchFinalityMs', 'relayAcceptFinalityMs', 'settleFinalityMs'])
        equal(r['crossChainFinalityMs'], r['registerBatchFinalityMs'] + r['relayAcceptFinalityMs'], 'testnet finality')
        residual.append({'round': r['round'], 'componentSumS': components_ms / 1000,
                         'totalS': r['endToEndMs'] / 1000, 'residualS': (r['endToEndMs'] - components_ms) / 1000})
    residual_stats = stats([r['residualS'] for r in residual])

    formal = read('verification/formal-verification.json')
    assert formal['passed'] and formal['queries'] == 12
    assert formal['stateModel']['result'] == 'PASS' and len(formal['stateModel']['invariants']) == 7
    circuit = read('verification/circuit-boundaries.json')
    assert circuit['cases'] == circuit['passed'] == 9
    assert read('verification/regression-results.json')['passed'] == 75
    settlement = read('verification/proof-to-settlement.json')
    assert settlement['onchainVerified'] and settlement['offchainVerified'] and settlement['reservedAmount'] == '0'
    withdrawal = rows('testnet/withdrawal_public_testnet.jsonl')
    assert withdrawal[-1]['rootReleased'] and withdrawal[-1]['escrowRestored'] and withdrawal[-1]['protectedBudgetRestored']

    # Compact data for the two measured figures; the paper preserves its vector artwork.
    figure2 = []
    for setting in ['authorization_only', 'committed_delivery', 'fair_release']:
        s = one(summaries['local/protocol'], settingId='ablation-' + setting, metric='totalMs')
        figure2.append({'panel': 'a', 'setting': setting, 'meanMs': s['mean'], 'p95Ms': s['p95']})
    for metric in ['modelRequestMs', 'totalMs']:
        s = one(summaries['llm/real_llm'], metric=metric)
        figure2.append({'panel': 'b', 'setting': metric, 'meanMs': s['mean'], 'p95Ms': s['p95']})
    figure3 = []
    for mode in ['local', 'remote']:
        for c in [1, 4, 8, 16]:
            s = one(summaries['wan/wan'], transportMode=mode, concurrency=c, metric='totalMs')
            t = one(summaries['wan/wan'], transportMode=mode, concurrency=c, metric='throughputOpsPerSecond')
            figure3.append({'placement': mode, 'concurrency': c, 'meanMs': s['mean'], 'p95Ms': s['p95'], 'goodput': t['mean']})
    table5 = []
    for label, time_metric, gas_metric in [
        ('Groth16 proof generation', 'proveMs', None),
        ('Amoy proof registration', 'registerBatchFinalityMs', 'registerBatchGas'),
        ('Sepolia root acceptance', 'relayAcceptFinalityMs', 'relayAcceptGas'),
        ('Sepolia receipt settlement', 'settleFinalityMs', 'settleGas'),
        ('Proof-to-settlement path', 'endToEndMs', None)]:
        s = stats([r[time_metric] / 1000 for r in testnet])
        table5.append({'stage': label, 'meanS': s['mean'], 'p95S': s['p95'],
                       'meanGas': None if gas_metric is None else stats([r[gas_metric] for r in testnet])['mean']})
    table5.insert(4, {'stage': 'Submission and coordination residual', 'meanS': residual_stats['mean'],
                      'p95S': residual_stats['p95'], 'meanGas': None})

    return {'status': 'PASS', 'hashVerifiedFiles': len(manifest['files']), 'recalculatedSummaryRows': summary_count,
            'sampleCounts': counts, 'batchPolicySettings': len(batch), 'simulatedArrivals': sum(r['arrivals'] for r in batch),
            'table3': summaries['local/zk'], 'table4': summaries['fault-gas/gas_policy_baseline'],
            'table5': table5, 'table5PerRoundResidual': residual, 'table5ResidualStatsSeconds': residual_stats,
            'table6': summaries['fault-gas/fault'], 'figure2': figure2, 'figure3': figure3,
            'localMeasurementWindows': local_windows, 'wanAggregateAudit': wan_windows,
            'limitations': [
                'WAN goodput is a retained aggregate. The original complete-window timer was not serialized; its exact value cannot be independently recalculated from per-call latencies.',
                'Legacy throughput percentile/CI fields repeat one aggregate and are not distributions or confidence intervals. WAN count is the completed-call count.',
                'The original ci95 fields use mean +/- 1.96 * sample_sd / sqrt(n); small-sample coverage is not established. The paper reports selected descriptive percentiles.',
                'The Table 5 residual is derived per round; its constituent RPC and coordination operations were not individually timed.',
                'Verification files preserve historical outcomes, not a fresh execution or an independent audit.'
            ]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, help='Optional path for a derived JSON report')
    args = parser.parse_args()
    report = audit()
    if args.output:
        destination = args.output.resolve()
        assert DATA.resolve() not in destination.parents, 'Do not overwrite the retained dataset'
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: report[k] for k in ['status', 'hashVerifiedFiles', 'recalculatedSummaryRows',
                                           'sampleCounts', 'batchPolicySettings', 'simulatedArrivals', 'table5']}))
    print('NOTE: WAN goodput uses retained aggregates; see data/measurement-20261015/README.md.')


if __name__ == '__main__':
    main()
