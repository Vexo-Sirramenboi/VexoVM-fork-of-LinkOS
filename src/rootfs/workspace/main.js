const started = Date.now();
let ticks = 0;

emit({ stream: 'stdout', text: 'worker booted with ' + Object.keys(fs).length + ' mounted files' });

setInterval(() => {
  ticks += 1;
  const uptime = Math.round((Date.now() - started) / 1000);
  emit({
    stream: 'metric',
    cpu: 18 + (ticks * 7) % 31,
    heap: 22 + (ticks * 5) % 46,
    io: byteLength(fs['/workspace/README.md'] || '') + ticks,
    text: 'tick=' + ticks + ' uptime=' + uptime + 's'
  });
}, 900);

function byteLength(value) {
  return new TextEncoder().encode(String(value)).length;
}
