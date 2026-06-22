// Validates the matcher against the REAL Hex history on this machine.
// Run: pnpm run build && pnpm run test:match

import { readHistory } from './hex';
import { matchTranscriptByWindow } from './matcher';

const { ok, transcripts, error } = readHistory();
if (!ok) {
  console.error('cannot read history:', error);
  process.exit(1);
}
console.log(`loaded ${transcripts.length} transcripts\n`);

let pass = 0;
let fail = 0;
const N = Math.min(15, transcripts.length);
for (let i = 0; i < N; i++) {
  const t = transcripts[i];
  const m = matchTranscriptByWindow({
    transcripts,
    seenIds: null,
    tStartMs: t.startUnixMs ?? 0,
    tFinishMs: t.endUnixMs ?? 0,
  });
  const good = !!m && m.transcript.id === t.id;
  if (good) pass++;
  else fail++;
  console.log(
    `${good ? 'PASS' : 'FAIL'}  dur=${t.durationSec.toFixed(1)}s  ` +
      `score=${m ? m.score.toFixed(2) : 'n/a'}  conf=${m ? m.confidence.toFixed(2) : 'n/a'}  ` +
      `acc=${m ? m.accepted : 'n/a'}  "${t.text.slice(0, 44).replace(/\n/g, ' ')}"`
  );
}

console.log(`\n${pass}/${pass + fail} transcripts recovered by their own window.`);
if (fail > 0) process.exitCode = 1;
