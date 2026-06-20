'use strict';

// Validates the matcher against the REAL Hex history on this machine.
// Run: node daemon/test-match.js
//
// For each recent transcript we reconstruct a plausible [start, finish] window from
// its own timing and confirm the matcher recovers exactly that transcript (and not a
// neighbour of similar length/time).

const { readHistory } = require('./hex');
const { matchTranscriptByWindow } = require('./matcher');

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
  // Simulate the extension's measured window: you start ~duration before Hex's
  // stamp and stop ~at it.
  const m = matchTranscriptByWindow({
    transcripts,
    seenIds: null,
    tStartMs: t.startUnixMs,
    tFinishMs: t.endUnixMs,
  });
  const good = m && m.transcript.id === t.id;
  good ? pass++ : fail++;
  console.log(
    `${good ? 'PASS' : 'FAIL'}  dur=${t.durationSec.toFixed(1)}s  ` +
      `score=${m ? m.score.toFixed(2) : 'n/a'}  conf=${m ? m.confidence.toFixed(2) : 'n/a'}  ` +
      `acc=${m ? m.accepted : 'n/a'}  "${t.text.slice(0, 44).replace(/\n/g, ' ')}"`
  );
}

console.log(`\n${pass}/${pass + fail} transcripts recovered by their own window.`);
if (fail > 0) process.exitCode = 1;
