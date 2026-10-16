"""Plot newly generated summaries; no paper measurements are embedded."""
import argparse
import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--local', type=Path, help='Directory containing protocol_summary.json')
parser.add_argument('--wan', type=Path, help='Directory containing wan_summary.json')
parser.add_argument('--output', type=Path, default=Path('runtime/figures'))
args = parser.parse_args()
if not args.local and not args.wan:
    parser.error('provide --local and/or --wan')
args.output.mkdir(parents=True, exist_ok=True)
plt.rcParams.update({'font.family': 'serif', 'font.size': 10, 'pdf.fonttype': 42})

def one(rows, **criteria):
    matches = [r for r in rows if all(r.get(k) == v for k, v in criteria.items())]
    if len(matches) != 1:
        raise ValueError(f'Expected one row for {criteria}; found {len(matches)}')
    return matches[0]

def save(fig, name):
    fig.tight_layout()
    fig.savefig(args.output / (name + '.pdf'), bbox_inches='tight')
    fig.savefig(args.output / (name + '.png'), dpi=200, bbox_inches='tight')
    plt.close(fig)

if args.local:
    rows = json.loads((args.local / 'protocol_summary.json').read_text())
    fig, axes = plt.subplots(1, 2, figsize=(8.5, 3.1))
    labels = ['Authorization only', 'Committed delivery', 'Confirmation-gated delivery']
    ablations = ['authorization_only', 'committed_delivery', 'fair_release']
    data = [one(rows, scenario='fair-delivery-ablation', ablation=a, metric='totalMs')
            for a in ablations]
    for ax, metric, title in zip(axes, ['mean', 'p95'], ['(a) Mean latency', '(b) P95 latency']):
        ax.barh(range(len(data)), [r[metric] for r in data], color='#2878b5', zorder=3)
        ax.set_yticks(range(len(data)), labels)
        ax.invert_yaxis()
        ax.set_xlabel('Latency (ms)')
        ax.set_title(title, fontweight='bold')
        ax.grid(axis='x', color='0.85', zorder=0)
    save(fig, 'local_delivery_reproduction')

if args.wan:
    rows = json.loads((args.wan / 'wan_summary.json').read_text())
    concurrency = sorted({r['concurrency'] for r in rows if r['recordType'] == 'wan_protocol_sample'})
    fig, axes = plt.subplots(1, 2, figsize=(8.5, 3.1))
    positions = list(range(len(concurrency)))
    for offset, transport, color, marker, label in [
        (-0.19, 'local', '#2878b5', 'o', 'Local'),
        (0.19, 'remote', '#ef8a35', 's', 'WAN'),
    ]:
        latency = [one(rows, recordType='wan_protocol_sample', transportMode=transport,
                       concurrency=c, metric='totalMs') for c in concurrency]
        throughput = [one(rows, recordType='wan_protocol_sample', transportMode=transport,
                          concurrency=c, metric='throughputOpsPerSecond') for c in concurrency]
        axes[0].bar([x + offset for x in positions], [r['mean'] for r in latency],
                    width=0.36, color=color, label=label, zorder=3)
        axes[1].plot(positions, [r['mean'] for r in throughput], color=color,
                     marker=marker, label=label, zorder=3)
    for ax, title, ylabel in zip(axes, ['(a) Mean delivery latency', '(b) Goodput'],
                                  ['Latency (ms)', 'Calls per second']):
        ax.set_xticks(positions, concurrency)
        ax.set_xlabel('Concurrency')
        ax.set_ylabel(ylabel)
        ax.set_title(title, fontweight='bold')
        ax.set_xlim(-0.5, len(concurrency) - 0.5)
        ax.grid(color='0.85', zorder=0)
        ax.legend()
    save(fig, 'wan_reproduction')
