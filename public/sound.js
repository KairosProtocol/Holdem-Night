// Table sounds, synthesized with Web Audio (no audio files). Packs change the timbre; 'off' mutes.
const Sound = (() => {
  let ctx, master, noiseBuf;
  let pack = 'classic', volume = 0.6;

  // Browsers only allow audio after a user gesture.
  function init() {
    if (ctx) return void (ctx.state === 'suspended' && ctx.resume());
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  addEventListener('pointerdown', init);
  addEventListener('keydown', init);

  function env(node, t, peak, dur) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    node.connect(g);
    g.connect(master);
  }
  // Filtered noise burst: card slides, flicks, swooshes.
  function noise(t, dur, freq, q, peak, sweepTo) {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter();
    s.buffer = noiseBuf;
    f.type = 'bandpass';
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    f.Q.value = q;
    s.connect(f);
    env(f, t, peak, dur);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.05);
  }
  function tone(t, freq, dur, type, peak, slideTo) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    env(o, t, peak, dur);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  const arp = (t, freqs, gap, dur, type, peak) => freqs.forEach((f, k) => tone(t + k * gap, f, dur, type, peak));

  const packs = {
    classic: {
      card: t => { noise(t, 0.07, 3400, 0.9, 0.55, 1700); noise(t + 0.05, 0.03, 900, 1.5, 0.25); },
      flip: t => { noise(t, 0.04, 5000, 1.2, 0.4); noise(t + 0.035, 0.07, 2300, 1, 0.4, 1200); },
      chip: t => { for (let k = 0; k < 3; k++) tone(t + k * 0.04 + Math.random() * 0.012, 2500 + Math.random() * 1100, 0.08, 'sine', 0.16); },
      knock: t => { tone(t, 150, 0.09, 'sine', 0.7, 70); noise(t, 0.03, 700, 1, 0.35); tone(t + 0.12, 150, 0.08, 'sine', 0.5, 70); },
      fold: t => noise(t, 0.28, 2200, 0.6, 0.35, 300),
      turn: t => arp(t, [660, 990], 0.12, 0.3, 'sine', 0.22),
      win: t => { arp(t, [523, 659, 784, 1047], 0.09, 0.35, 'triangle', 0.2); for (let k = 0; k < 6; k++) tone(t + 0.3 + k * 0.05, 2400 + Math.random() * 1400, 0.07, 'sine', 0.1); },
      tick: t => tone(t, 1800, 0.03, 'square', 0.07),
    },
    arcade: {
      card: t => tone(t, 880, 0.05, 'square', 0.1, 440),
      flip: t => tone(t, 520, 0.08, 'square', 0.1, 1040),
      chip: t => arp(t, [1320, 1760], 0.05, 0.06, 'square', 0.08),
      knock: t => tone(t, 220, 0.08, 'square', 0.12, 110),
      fold: t => tone(t, 400, 0.25, 'sawtooth', 0.08, 80),
      turn: t => arp(t, [784, 988, 1319], 0.07, 0.1, 'square', 0.08),
      win: t => arp(t, [523, 659, 784, 1047, 1319, 1568], 0.07, 0.14, 'square', 0.08),
      tick: t => tone(t, 1000, 0.03, 'square', 0.05),
    },
    soft: {
      card: t => noise(t, 0.1, 1300, 0.5, 0.3, 800),
      flip: t => tone(t, 700, 0.12, 'sine', 0.14, 900),
      chip: t => tone(t, 1600, 0.16, 'sine', 0.1),
      knock: t => tone(t, 110, 0.14, 'sine', 0.35, 80),
      fold: t => noise(t, 0.32, 700, 0.4, 0.22, 200),
      turn: t => tone(t, 523, 0.45, 'sine', 0.16),
      win: t => arp(t, [392, 523, 659], 0.12, 0.5, 'sine', 0.14),
      tick: t => tone(t, 900, 0.04, 'sine', 0.05),
    },
  };

  return {
    set(p, v) {
      pack = p;
      volume = v;
      if (master) master.gain.value = v;
    },
    play(name, delay = 0) {
      if (!ctx || ctx.state !== 'running' || !packs[pack]) return;
      packs[pack][name](ctx.currentTime + delay);
    },
  };
})();
