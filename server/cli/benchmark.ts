/**
 * npm run research:benchmark [-- --out docs/benchmarks/vl-004b-offline.md]
 * Offline benchmark of the live adapters' guardrails on recorded HTTP. No network, no database.
 */
import { writeFileSync } from 'node:fs';
import { benchmarkMarkdown, runBenchmark } from '../live/benchmark';

const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;
const b = await runBenchmark();
const md = benchmarkMarkdown(b);
if (out) writeFileSync(out, md);
console.log(md);
