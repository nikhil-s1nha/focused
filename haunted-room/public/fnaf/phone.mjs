// Night-intro phone calls. Pure: no THREE/DOM/audio. The narrator is an original, cheerful night-guard
// handbook voice. Lines are subtitle-first; audio layers may synthesize or play recorded voice per line event.

export const PHONE_MODES = Object.freeze(['fnaf1', 'fnaf2', 'fnaf3', 'fnaf4']);
const LEAD = 0.8;     // s of silence before the first line
const GAP = 0.9;      // s between lines
const CPS = 15;       // reading speed, characters per second
const MIN_DUR = 1.6;

function build(texts) {
  let at = LEAD;
  return texts.map((text, i) => {
    const dur = Math.max(MIN_DUR, text.length / CPS);
    const line = { index: i, text, at, dur };
    at += dur + GAP;
    return line;
  });
}

const RAW = {
  fnaf1: {
    1: ['Hello, and welcome to the Handbook for Overnight Guardians, chapter one, the cheerful chapter.',
      'Your post is a small office with two doors, a bright lamp and a camera tablet. Please enjoy all three.',
      'The performers on the stage are wonderfully lively after midnight. That is simply how they stay in tune.',
      'If one comes calling, close the door. Doors are friendly. They also use power, so be generous but not wasteful.',
      'Six hours until morning. You will be fine. The handbook says so.'],
    2: ['Chapter two. Congratulations on being alive, which the handbook counts as excellent progress.',
      'The cove curtain has been twitching again. Watching it is polite. Ignoring it is how it gets ideas.',
      'Keep an eye on the tablet, but not too long. Everything on the tablet is also watching you.'],
    3: ['Chapter three, a short one. The power meter is a number you should keep large.',
      'Some of our performers hum when the lights are low. If you hear humming, that is enthusiasm.'],
    4: ['Chapter four. Do not worry about the footsteps. Worry, gently, about where they stop.',
      'The handbook recommends a calm voice. Please practice on the nearest doorway.'],
    5: ['Chapter five, nearly done. The doors are still your friends. The lamp is still your friend.',
      'Everyone else is simply very, very friendly.'],
    6: ['Chapter six, the nightmare appendix. It was not in the original handbook. Someone added it by hand.',
      'Good luck. The handbook has run out of cheerful things to say.'],
  },
  fnaf2: {
    1: ['Hello, and welcome to the handbook for the Prize Corner shift. This edition has fewer doors and more mask.',
      'You have a flashlight, a mask and a wind-up music box. Each is wonderful. Use them in good health.',
      'The music box must never run down. Whoever lives in the little gift box dislikes silence.',
      'Please keep the light on the hallway. Light is a very persuasive argument.'],
    2: ['Chapter two. There are vents on both sides of the desk. Think of them as very narrow guest entrances.',
      'If someone is standing beside you, put on the mask. Pretend you are one of them. Method acting saves lives.'],
    3: ['Chapter three. The older performers are held together by optimism and tape. They are also quicker to anger.',
      'Wind the box, check the vents, breathe. In that order. Mostly.'],
    4: ['Chapter four. If the hallway goes dark, the handbook suggests not panicking. Panic is loud.',
      'The mask lasts as long as you can hold your nerve, which is about three seconds.'],
    5: ['Chapter five. The music box is a promise. Keep it, and the night keeps its promise too.'],
    6: ['Chapter six. Everything here is faster, thinner and much too interested in you.',
      'The handbook wishes you a lovely night. It is lying, gently.'],
  },
  fnaf3: {
    1: ['Welcome, guardian, to the handbook appendix for the attraction after hours.',
      'The monitors show cameras, vents and an audio lure. The lure is a sound. Sounds are decoys.',
      'One of the exhibits is not an exhibit. The handbook cannot tell you which. It has tried.'],
    2: ['Chapter two. Systems misbehave in old buildings. Reboot a panel, and it forgives you, mostly.',
      'The ventilation fan sounds like a sigh. Please do not sigh back.'],
    3: ['Chapter three. When the screen flickers, the handbook suggests blinking slowly. It helps nothing.',
      'It does, however, make you look calm.'],
    4: ['Chapter four. The lure has a pleasant tone. So do the things it attracts.',
      'Keep the doors in mind, keep the vents in mind, keep your mind in mind.'],
    5: ['Chapter five. Almost morning. The attraction would like to remind you that it is closed.'],
    6: ['Chapter six, the appendix to the appendix. It is shorter than expected.',
      'Everything on the cameras is in a hurry. Be unhurried. Be a lighthouse.'],
  },
  fnaf4: {
    1: ['Hello, and welcome to chapter one of the Handbook for Brave Bedtimes. Tonight we are listening.',
      'The room has four doors: left, right, the closet and the hallway. Each can be shut. Each can be breathed behind.',
      'When you hear breathing, close that door and hold it. Hold it firmly, for a slow count of two.',
      'Letting go early is rude, and it is noticed. Closing a door on nothing wastes time, and time is attentive.',
      'The flashlight is a lovely thing, but do not stare. Nothing enjoys being stared at in a doorway.'],
    2: ['Chapter two. Remember, breathing means company. Silence means the door is safe to leave alone.',
      'If the closet sounds like tiny feet, that is the small ones. A short flash of light reminds them of their manners.'],
    3: ['Chapter three. The hallway has begun to learn your habits. Please try to have fewer habits.',
      'Closing doors you do not need to close teaches the house that you are afraid. The house is a quick study.'],
    4: ['Chapter four. If two doors are breathing, choose the nearer fear first.',
      'Hold, count, release. Hold, count, release. It is practically a lullaby.'],
    5: ['Chapter five. You are doing wonderfully, which is a thing the handbook says to everyone.',
      'The small ones are quieter now. That is not the same as gone.'],
    6: ['Chapter six, the bedtime nightmare edition. The doors need a little longer to be convinced.',
      'This time, the small ones do not need your light. Let them be. The light tells the closet where you are.'],
  },
};

export const PHONE_SCRIPTS = Object.freeze(Object.fromEntries(Object.entries(RAW).map(([mode, nights]) => [
  mode, Object.freeze(Object.fromEntries(Object.entries(nights).map(([n, texts]) => [n, build(texts)]))),
])));

/** Script for a mode/night as {id, mode, night, lines[{index,text,at,dur}], duration}, or null if none. */
export function getPhoneScript(mode, night) {
  const lines = PHONE_SCRIPTS[mode]?.[night];
  if (!lines) return null;
  const last = lines[lines.length - 1];
  return { id: `${mode}-night${night}`, mode, night, lines, duration: last.at + last.dur + GAP };
}

export class PhoneCall {
  /** @param {{script?:object, mode?:string, night?:number, muted?:boolean}} opts */
  constructor({ script = null, mode = 'fnaf1', night = 1, muted = false } = {}) {
    this.script = script ?? getPhoneScript(mode, night);
    this.muted = !!muted;
    this.events = [];
    this.state = 'idle'; // idle | playing | ended
    this.t = 0; this.index = -1; this.activeLine = null; this.endReason = null;
  }
  emit(e) { this.events.push(e); }
  consumeEvents() { const e = this.events; this.events = []; return e; }
  setMuted(m) { this.muted = !!m; }
  start() {
    if (!this.script || this.state === 'playing') return false;
    this.state = 'playing'; this.t = 0; this.index = -1; this.activeLine = null; this.endReason = null;
    this.emit({ type: 'phone-call-start', id: this.script.id, mode: this.script.mode, night: this.script.night, muted: this.muted });
    return true;
  }
  update(dt) {
    if (this.state !== 'playing') return;
    this.t += Math.max(0, dt);
    for (;;) {
      if (this.activeLine && this.t >= this.activeLine.at + this.activeLine.dur) {
        this.emit({ type: 'phone-line-end', index: this.activeLine.index });
        this.activeLine = null;
      }
      const next = this.script.lines[this.index + 1];
      if (!this.activeLine && next && this.t >= next.at) {
        this.index++; this.activeLine = next;
        this.emit({ type: 'phone-line', index: next.index, text: next.text, dur: next.dur, muted: this.muted, last: next.index === this.script.lines.length - 1 });
        continue;
      }
      break;
    }
    if (!this.activeLine && this.index === this.script.lines.length - 1 && this.t >= this.script.duration) this.finish('finished');
  }
  finish(reason) {
    if (this.state !== 'playing') return false;
    if (this.activeLine) { this.emit({ type: 'phone-line-end', index: this.activeLine.index, cut: true }); this.activeLine = null; }
    this.state = 'ended'; this.endReason = reason;
    this.emit({ type: 'phone-call-end', id: this.script.id, reason, interrupted: reason === 'interrupted' });
    return true;
  }
  skip() { return this.finish('skipped'); }
  /** Hook for the host: an attack cut the call off (e.g. on a mode jumpscare event). */
  interrupt() { return this.finish('interrupted'); }
  snapshot() {
    return {
      id: this.script?.id ?? null, active: this.state === 'playing', ended: this.state === 'ended', endReason: this.endReason,
      index: this.index, subtitle: this.activeLine ? this.activeLine.text : null, muted: this.muted,
      elapsed: this.t, duration: this.script?.duration ?? 0,
      progress: this.script ? Math.min(1, this.t / this.script.duration) : 0,
    };
  }
}
