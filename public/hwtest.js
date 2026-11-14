'use strict';
/* CONTROLLER TEST: an accurate hardware inventory and a test of every function of the Numark Party Mix.
   - INVENTORY: the USB interfaces Windows sees for the controller, its MIDI ports, the Windows audio outputs (with volume and MUTE), the engine's audio devices and routing.
   - CONTROLS: every raw MIDI message the controller sends is recorded per control (range, steps, glitches, press / release behaviour: momentary or latching); unknown messages are listed too.
   - LEDS: every LED can be set off / dim / on; a sweep finds LEDs we do not know about; you mark what you saw.
   - AUDIO: test tones on the master and on the headphones, with the routing shown.
   - REPORT: a Markdown + JSON report saved to a folder. Nothing here changes a Windows setting. Globals: nat, engSend, calib, midiOut, lsGet, toast. */
(() => {
  const $ = (s, el) => (el || document).querySelector(s), esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const S = { msgs: new Map(), t0: performance.now(), led: {}, audio: {}, inv: null, probe: { found: [], running: false, cur: null }, sentLog: [], tab: 'inventory' };
  const hex = n => '0x' + (n | 0).toString(16).toUpperCase().padStart(2, '0');
  const kindOf = st => ({ 0xB0: 'c', 0xE0: 'p', 0x90: 'n', 0x80: 'n' })[st & 0xF0];
  const keyOf = (st, d1) => { const k = kindOf(st); return k ? (k === 'p' ? `p:${st & 15}` : `${k}:${st & 15}:${d1}`) : null; };
  const niceKey = k => { const [t, ch, n] = k.split(':'); return t === 'n' ? `Note ${hex(+n)} · ch ${+ch + 1}` : t === 'c' ? `CC ${hex(+n)} · ch ${+ch + 1}` : `Pitch bend · ch ${+ch + 1}`; };

  /* ---------------------------------------------------------------- recording (called by app.js for every raw MIDI message; jog wheels are summarised) */
  function tap(data) {
    const [st, d1, d2 = 0] = data; const k = keyOf(st, d1); if (!k) return;
    const t = performance.now() - S.t0, kind = kindOf(st), v = kind === 'p' ? d1 | (d2 << 7) : d2, on = kind === 'n' ? ((st & 0xF0) === 0x90 && d2 > 0) : null;
    let m = S.msgs.get(k); if (!m) { m = { key: k, count: 0, min: 1e9, max: -1, vals: new Set(), ev: [], jumps: 0, last: null, firstT: t }; S.msgs.set(k, m); }
    m.count++; m.min = Math.min(m.min, v); m.max = Math.max(m.max, v); if (m.vals.size < 256) m.vals.add(v);
    if (m.last != null && kind === 'c' && Math.abs(v - m.last) > 16 && !/^c:\d+:6$/.test(k)) m.jumps++;
    m.last = v; m.lastT = t; if (m.ev.length < 400) m.ev.push([Math.round(t), kind === 'n' ? (on ? 1 : 0) : v]); else if (kind !== 'n') { m.ev.shift(); m.ev.push([Math.round(t), v]); }
  }
  window.__midiTap = tap;
  const controlKey = id => { const e = window.calib && calib.cal && calib.cal.map && calib.cal.map[id]; return e && e.key; };
  /* analysis of one control from what it sent */
  function analyse(c) {
    const key = controlKey(c.id), m = key && S.msgs.get(key);
    if (!key) return { st: 'unmapped', text: 'not mapped (run Calibrate)' };
    if (!m) return { st: 'untested', text: niceKey(key) + ' · nothing received yet' };
    const base = `${niceKey(key)} · ${m.count} messages`;
    if (c.t === 'button') {
      const ev = m.ev, ons = ev.filter(e => e[1] === 1), offs = ev.filter(e => e[1] === 0); let paired = 0, hold = 0;
      for (const o of ons) { const f = offs.find(x => x[0] > o[0] && x[0] - o[0] < 1500); if (f) { paired++; hold += f[0] - o[0]; } }
      const mode = !ons.length ? 'no press seen' : paired >= Math.max(1, ons.length * 0.7) ? `momentary (press + release, ~${Math.round(hold / paired)} ms)` : offs.length ? 'LATCHING: sends ON and OFF on alternate presses' : 'press only (no release message)';
      const vel = [...m.vals].filter(x => x > 0); return { st: ons.length ? (/LATCHING|press only/.test(mode) ? 'warn' : 'ok') : 'untested', text: `${base} · ${mode}${vel.length > 1 ? ' · velocity ' + Math.min(...vel) + '..' + Math.max(...vel) : ''}`, mode };
    }
    if (c.t === 'jog' || c.t === 'browse') { const vals = [...m.vals].sort((a, b) => a - b); return { st: m.count >= 5 ? 'ok' : 'untested', text: `${base} · values ${vals.slice(0, 12).join(',')}${vals.length > 12 ? '…' : ''} (relative encoder)` }; }
    const cov = (m.max - m.min) / 127, okRange = m.min <= 12 && m.max >= 115, steps = m.vals.size;
    return { st: okRange ? (m.jumps ? 'warn' : 'ok') : 'untested', text: `${base} · range ${m.min}..${m.max} (${Math.round(cov * 100)} %) · ${steps} distinct values${m.jumps ? ' · ' + m.jumps + ' jumps >16 (noisy / worn track)' : ''}${okRange ? '' : ' · move it over its whole travel'}` };
  }

  /* ---------------------------------------------------------------- LEDs */
  const LEDS = [];
  for (const d of [0, 1]) {
    const D = d ? 'B' : 'A';
    for (const [n, name] of [[0x00, 'PLAY'], [0x01, 'CUE'], [0x02, 'SYNC'], [0x07, 'SCRATCH / Harmonic Match'], [0x1B, 'HEADPHONE (PFL)']]) LEDS.push({ id: `d${d}.${n}`, label: `Deck ${D} · ${name}`, st: 0x90 + d, note: n });
    for (let p = 0; p < 4; p++) LEDS.push({ id: `d${d}.pad${p + 1}`, label: `Deck ${D} · PAD ${p + 1}`, st: 0x94 + d, note: 0x14 + p });
  }
  const send = (st, n, v) => { try { if (typeof midiOut !== 'undefined' && midiOut) { midiOut.send([st, n, v]); S.sentLog.push([Math.round(performance.now() - S.t0), st, n, v]); if (S.sentLog.length > 300) S.sentLog.shift(); return true; } } catch {} return false; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function ledSequence(l) { for (const v of [0, 1, 127, 0]) { send(l.st, l.note, v); setStatus(`${l.label}: sent velocity ${v}`); await sleep(v === 127 ? 1000 : 700); } setStatus(`${l.label}: done. Mark what you saw.`); }
  async function ledSweep() { for (const l of LEDS) { send(l.st, l.note, 127); setStatus(`Sweep: ${l.label} ON`); await sleep(650); send(l.st, l.note, 0); } setStatus('Sweep finished'); }
  async function probe(chs) {
    if (S.probe.running) { S.probe.running = false; return; } S.probe.running = true; S.probe.found = S.probe.found || [];
    for (const ch of chs) for (let n = 0; n < 128 && S.probe.running; n++) { S.probe.cur = [0x90 | ch, n]; send(0x90 | ch, n, 127); setStatus(`Probe: channel ${ch + 1}, note ${hex(n)}: press "I SEE A LIGHT" when something lights`); render(); await sleep(260); send(0x90 | ch, n, 0); }
    S.probe.running = false; S.probe.cur = null; setStatus('Probe finished'); render();
  }

  /* ---------------------------------------------------------------- inventory */
  async function loadInventory() {
    const inv = { web: { inputs: [], outputs: [] }, engine: [], status: nat.status || null, windows: null, time: new Date().toISOString(), platform: navigator.platform, ua: navigator.userAgent.replace(/.*(Electron\/[\d.]+).*/, '$1') };
    try { const a = await navigator.requestMIDIAccess({ sysex: false }); a.inputs.forEach(p => inv.web.inputs.push({ name: p.name, manufacturer: p.manufacturer, id: p.id, state: p.state, connection: p.connection })); a.outputs.forEach(p => inv.web.outputs.push({ name: p.name, manufacturer: p.manufacturer, id: p.id, state: p.state, connection: p.connection })); } catch (e) { inv.web.error = e.message; }
    inv.engine = (nat.devices || []).map(d => ({ name: d.name, maxChannels: d.maxChannels, rates: d.rates, isDefault: d.isDefault }));
    if (window.electronAPI && window.electronAPI.hwInventory) { try { inv.windows = await window.electronAPI.hwInventory(); } catch (e) { inv.windows = { error: e.message }; } }
    S.inv = inv; render(); return inv;
  }
  const epInfo = e => { const m = /volume=(\d+)% mute=(True|False)/.exec(e.info || ''); return m ? { volume: +m[1], mute: m[2] === 'True' } : { volume: null, mute: null }; };

  /* ---------------------------------------------------------------- UI */
  const dlg = document.createElement('div'); dlg.id = 'hwtest'; dlg.hidden = true; document.body.appendChild(dlg);
  let live = 0;
  const setStatus = t => { const s = $('#hwStatus'); if (s) s.textContent = t; };
  const badge = st => `<span class="hwb ${st}">${({ ok: 'OK', warn: 'CHECK', untested: '–', unmapped: 'N/A' })[st] || st}</span>`;
  function tabInventory() {
    const inv = S.inv; if (!inv) return '<p class="dim">Reading the hardware…</p>';
    const w = inv.windows || {}, party = (inv.web.inputs.concat(inv.web.outputs)).filter(p => /party/i.test(p.name));
    const usb = (w.usb || []).map(u => `<tr><td>${esc(u.name || '(no name)')}</td><td>${esc(u.class || '')}</td><td>${esc(u.status || '')}</td><td>${esc(u.service || '')}</td><td class="mono">${esc(u.id)}</td></tr>`).join('');
    const eps = (w.endpoints || []).map(e => { const i = epInfo(e), pm = /party mix/i.test(e.name); return `<tr class="${pm ? 'pm' : ''}"><td>${esc(e.name)}</td><td>${i.volume == null ? '?' : i.volume + ' %'}</td><td>${i.mute == null ? '?' : i.mute ? '<b class="bad">MUTED in Windows</b>' : 'not muted'}</td></tr>`; }).join('');
    const eng = inv.engine.map(d => `<tr class="${/party mix/i.test(d.name) ? 'pm' : ''}"><td>${esc(d.name)}</td><td>${d.maxChannels || '?'}</td><td>${(d.rates || []).join(', ')}</td><td>${d.isDefault ? 'default' : ''}</td></tr>`).join('');
    const s = inv.status || {};
    return `<h4>Controller on USB (what Windows reports)</h4><table class="hwt"><tr><th>Name</th><th>Class</th><th>Status</th><th>Driver</th><th>Instance</th></tr>${usb || '<tr><td colspan="5" class="bad">No USB device with vendor 15E4 found</td></tr>'}</table>
      <h4>MIDI ports (as the app sees them)</h4><table class="hwt"><tr><th>Direction</th><th>Name</th><th>Manufacturer</th><th>State</th></tr>${inv.web.inputs.map(p => `<tr><td>in</td><td>${esc(p.name)}</td><td>${esc(p.manufacturer)}</td><td>${p.state}/${p.connection}</td></tr>`).join('')}${inv.web.outputs.map(p => `<tr><td>out</td><td>${esc(p.name)}</td><td>${esc(p.manufacturer)}</td><td>${p.state}/${p.connection}</td></tr>`).join('')}</table>${party.length ? '' : '<p class="bad">No Party Mix MIDI port found.</p>'}
      <h4>Audio outputs in Windows (read only: nothing is changed)</h4><table class="hwt"><tr><th>Device</th><th>Volume</th><th>Mute</th></tr>${eps || '<tr><td colspan="3">not available</td></tr>'}</table>
      <h4>Audio devices seen by the engine</h4><table class="hwt"><tr><th>Device</th><th>Channels</th><th>Sample rates</th><th></th></tr>${eng}</table>
      <h4>Current routing</h4><p>Master: <b>${esc(s.masterName || '?')}</b> · cue: <b>${esc(s.cue || '?')}${s.cueName ? ' → ' + esc(s.cueName) : ''}</b> · ${s.channels || '?'} ch · ${s.sampleRate || '?'} Hz</p>
      <p class="dim">${esc(inv.platform)} · ${esc(inv.ua)} · read ${esc(inv.time)}</p>`;
  }
  function tabControls() {
    const rows = calib.CTRL.map(c => { const a = analyse(c); return `<tr><td>${badge(a.st)}</td><td>${esc(c.en)}</td><td>${esc(c.t)}</td><td>${esc(a.text)}</td></tr>`; }).join('');
    const known = new Set(calib.CTRL.map(c => controlKey(c.id)).filter(Boolean));
    const unk = [...S.msgs.values()].filter(m => !known.has(m.key) && !/^c:\d+:6$/.test(m.key)).map(m => `<tr><td>${esc(niceKey(m.key))}</td><td>${m.count}</td><td>${m.min}..${m.max}</td></tr>`).join('');
    const done = calib.CTRL.filter(c => analyse(c).st === 'ok').length;
    return `<p><b>${done} / ${calib.CTRL.length}</b> controls tested OK. Move or press every control on the controller; each row turns green when it behaved. Latching or noisy controls are flagged CHECK.</p>
      <table class="hwt"><tr><th></th><th>Control</th><th>Type</th><th>What the controller sent</th></tr>${rows}</table>
      <h4>Other messages seen (not mapped to a control)</h4><table class="hwt"><tr><th>Message</th><th>Count</th><th>Values</th></tr>${unk || '<tr><td colspan="3" class="dim">none</td></tr>'}</table>`;
  }
  function tabLeds() {
    const rows = LEDS.map(l => { const r = S.led[l.id] || {}; const cb = (k, t) => `<label><input type="checkbox" data-led="${l.id}" data-k="${k}"${r[k] ? ' checked' : ''}> ${t}</label>`; return `<tr><td>${esc(l.label)}</td><td class="mono">${hex(l.st)} ${hex(l.note)}</td><td><button data-lseq="${l.id}">Test</button><button data-lset="${l.id}:0">OFF</button><button data-lset="${l.id}:1">DIM 1</button><button data-lset="${l.id}:127">ON 127</button></td><td>${cb('on', 'lit at 127')} ${cb('dim', 'visible at 1')} ${cb('dark', 'dark at 0')}</td></tr>`; }).join('');
    const pr = S.probe, found = (pr.found || []).map(f => `<li>${hex(f[0])} note ${hex(f[1])}</li>`).join('');
    return `<p>The app's own LED output is paused while this window is open. <b>Test</b> sends 0, 1, 127, 0 to that LED; tick what you actually saw. A LED that is not <i>dark at 0</i> keeps glowing when the app thinks it is off.</p>
      <p><button id="hwSweep">Light every known LED one after the other</button> <button id="hwAllOff">All known LEDs off</button></p>
      <table class="hwt"><tr><th>LED</th><th>Message</th><th>Set</th><th>What you saw</th></tr>${rows}</table>
      <h4>Find LEDs we do not know about</h4><p>Sends "on" to every note of the chosen MIDI channels, one by one. Press <b>I SEE A LIGHT</b> when something lights (it records the note).</p>
      <p><button id="hwProbe">${pr.running ? 'Stop probe' : 'Probe channels 1, 2, 5 and 6 (about 2 minutes)'}</button> <button id="hwSee" ${pr.running ? '' : 'disabled'}>I SEE A LIGHT</button> <span class="mono">${pr.cur ? 'now: ' + hex(pr.cur[0]) + ' ' + hex(pr.cur[1]) : ''}</span></p><ul>${found || '<li class="dim">none recorded</li>'}</ul>`;
  }
  function tabAudio() {
    const s = (S.inv && S.inv.status) || nat.status || {}, a = S.audio; const cb = (k, t) => `<label><input type="checkbox" data-audio="${k}"${a[k] ? ' checked' : ''}> ${t}</label>`;
    const mut = ((S.inv && S.inv.windows && S.inv.windows.endpoints) || []).filter(e => epInfo(e).mute).map(e => e.name);
    return `<p>Master: <b>${esc(s.masterName || '?')}</b> · headphone cue: <b>${esc(s.cue || '?')}${s.cueName ? ' → ' + esc(s.cueName) : ''}</b></p>${mut.length ? `<p class="bad">Windows has these outputs muted: ${esc(mut.join(', '))}. Unmute them in Windows Sound settings, then test again.</p>` : ''}
      <p><button id="hwBeepM">Play a test tone on the MASTER</button> ${cb('master', 'I heard it on the master output')}</p>
      <p><button id="hwBeepC">Play a test tone on the HEADPHONES (cue)</button> ${cb('cue', 'I heard it in the headphones')}</p>
      <p>Headphone volume (CUE MIX knob): move it while the tone or a cued deck plays; ${cb('vol', 'the headphone volume changes')}</p>`;
  }
  function report() {
    const inv = S.inv || {}, w = inv.windows || {}, s = inv.status || nat.status || {};
    const ctl = calib.CTRL.map(c => { const a = analyse(c), k = controlKey(c.id), m = k && S.msgs.get(k); return { id: c.id, name: c.en, type: c.t, key: k || null, status: a.st, detail: a.text, count: m ? m.count : 0, min: m ? m.min : null, max: m ? m.max : null, distinct: m ? m.vals.size : 0, jumps: m ? m.jumps : 0, mode: a.mode || null }; });
    const other = [...S.msgs.values()].filter(m => !calib.CTRL.some(c => controlKey(c.id) === m.key) && !/^c:\d+:6$/.test(m.key)).map(m => ({ key: m.key, count: m.count, min: m.min, max: m.max }));
    const json = { generated: new Date().toISOString(), controller: 'Numark Party Mix', inventory: inv, controls: ctl, otherMessages: other, leds: LEDS.map(l => ({ ...l, st: hex(l.st), note: hex(l.note), seen: S.led[l.id] || {} })), probeFound: S.probe.found, audio: S.audio };
    const md = [`# Party Mix hardware report`, `Generated ${json.generated}`, '', '## Inventory', `- USB: ${(w.usb || []).map(u => `${u.name} [${u.class}, ${u.status}, driver ${u.service}]`).join('; ') || 'none found'}`, `- MIDI in: ${(inv.web ? inv.web.inputs : []).map(p => p.name).join(', ') || 'none'}; out: ${(inv.web ? inv.web.outputs : []).map(p => p.name).join(', ') || 'none'}`,
      ...(w.endpoints || []).map(e => { const i = epInfo(e); return `- Windows output "${e.name}": volume ${i.volume}%, ${i.mute ? 'MUTED' : 'not muted'}`; }), ...(inv.engine || []).map(d => `- Engine device "${d.name}": ${d.maxChannels} ch, ${(d.rates || []).join('/')} Hz`), `- Routing: master ${s.masterName}, cue ${s.cue} ${s.cueName || ''}`, '',
      '## Controls', '| Status | Control | Message | Detail |', '|---|---|---|---|', ...ctl.map(c => `| ${c.status} | ${c.name} | ${c.key || ''} | ${c.detail} |`), '', '## Other messages', ...(other.length ? other.map(o => `- ${o.key}: ${o.count}x, ${o.min}..${o.max}`) : ['- none']), '', '## LEDs (what was seen)',
      ...LEDS.map(l => { const r = S.led[l.id] || {}; return `- ${l.label} (${hex(l.st)} ${hex(l.note)}): lit at 127 ${r.on ? 'yes' : 'not confirmed'}, visible at 1 ${r.dim ? 'yes' : 'no / not confirmed'}, dark at 0 ${r.dark ? 'yes' : 'not confirmed'}`; }), `- Unknown LEDs found by the probe: ${(S.probe.found || []).map(f => hex(f[0]) + ' ' + hex(f[1])).join(', ') || 'none'}`, '', '## Audio', `- Master tone heard: ${S.audio.master ? 'yes' : 'no / not tested'}`, `- Headphone tone heard: ${S.audio.cue ? 'yes' : 'no / not tested'}`, `- Headphone volume knob works: ${S.audio.vol ? 'yes' : 'no / not tested'}`].join('\n');
    return { md, json };
  }
  function render() {
    if (dlg.hidden) return; const tabs = [['inventory', 'INVENTORY'], ['controls', 'CONTROLS'], ['leds', 'LEDS'], ['audio', 'AUDIO'], ['report', 'REPORT']];
    const body = S.tab === 'inventory' ? tabInventory() : S.tab === 'controls' ? tabControls() : S.tab === 'leds' ? tabLeds() : S.tab === 'audio' ? tabAudio() : `<p><button id="hwSave">Save the report (Markdown + JSON)</button> <span id="hwSaved" class="dim"></span></p><textarea readonly>${esc(report().md)}</textarea>`;
    const keep = $('.hwbody', dlg) ? $('.hwbody', dlg).scrollTop : 0;
    dlg.innerHTML = `<div class="hwbox"><header><b>CONTROLLER TEST</b><span>Numark Party Mix: inventory and function test</span><button id="hwClose">Close</button></header><nav>${tabs.map(([k, n]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${n}</button>`).join('')}<button id="hwReread" title="Read the hardware again">↻ Re-read</button><span id="hwStatus" class="dim"></span></nav><div class="hwbody">${body}</div></div>`;
    $('.hwbody', dlg).scrollTop = keep;
  }
  dlg.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return; const id = b.id;
    if (b.dataset.tab) { S.tab = b.dataset.tab; render(); return; }
    if (id === 'hwClose') return close(); if (id === 'hwReread') { await loadInventory(); return; }
    if (b.dataset.lseq) return ledSequence(LEDS.find(l => l.id === b.dataset.lseq));
    if (b.dataset.lset) { const [lid, v] = b.dataset.lset.split(':'), l = LEDS.find(x => x.id === lid); send(l.st, l.note, +v); setStatus(`${l.label}: sent velocity ${v}`); return; }
    if (id === 'hwSweep') return ledSweep(); if (id === 'hwAllOff') { LEDS.forEach(l => send(l.st, l.note, 0)); return; }
    if (id === 'hwProbe') return probe([0, 1, 4, 5]); if (id === 'hwSee') { if (S.probe.cur) { S.probe.found.push(S.probe.cur.slice()); render(); } return; }
    if (id === 'hwBeepM') { engSend({ cmd: 'beep', target: 'master' }); setStatus('Tone sent to the master'); return; }
    if (id === 'hwBeepC') { engSend({ cmd: 'beep', target: 'cue' }); setStatus('Tone sent to the headphone cue'); return; }
    if (id === 'hwSave') { const r = report(); try { const p = await window.electronAPI.hwSaveReport('party-mix-hardware-report', r.md, JSON.stringify(r.json, null, 2)); $('#hwSaved').textContent = 'Saved: ' + p; } catch (er) { $('#hwSaved').textContent = 'Could not save: ' + er.message; } }
  });
  dlg.addEventListener('change', e => { const t = e.target; if (t.dataset.led) { (S.led[t.dataset.led] = S.led[t.dataset.led] || {})[t.dataset.k] = t.checked; } if (t.dataset.audio) S.audio[t.dataset.audio] = t.checked; });
  function open() { window.__ledHold = true; dlg.hidden = false; S.tab = S.tab || 'inventory'; render(); loadInventory(); clearInterval(live); live = setInterval(() => { if (!dlg.hidden && (S.tab === 'controls' || S.tab === 'inventory' && false)) { const y = $('.hwbody', dlg).scrollTop; $('.hwbody', dlg).innerHTML = tabControls(); $('.hwbody', dlg).scrollTop = y; } }, 400); }
  function close() { S.probe.running = false; LEDS.forEach(l => send(l.st, l.note, 0)); window.__ledHold = false; dlg.hidden = true; clearInterval(live); }
  const btn = document.getElementById('btnHw'); if (btn) btn.onclick = () => (dlg.hidden ? open() : close());
  window.hwtest = { open, close, S, analyse, report, tap, LEDS, loadInventory };
})();
