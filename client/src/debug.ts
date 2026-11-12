import { EMOTIONS } from "../../shared/protocol";
import { MOUTH_SPEED_TALKING, MOUTH_TABLE, charsToVisemes, visemeAt } from "./mouth";
import { CharacterRig, INPUT_MOUTH, INPUT_MOUTH_SPEED } from "./rig";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const rig = await CharacterRig.create($<HTMLCanvasElement>("rive"));
const info = rig.info();
(window as unknown as { rig: CharacterRig }).rig = rig; // for poking at it from the console

// Log every artboard, animation, state machine and input (type + default).
console.log("[rive] artboards", info.artboards);
console.table(info.animations);
for (const sm of info.stateMachines) {
  console.log(`[rive] state machine "${sm.name}"`);
  console.table(sm.inputs);
}
$("info").textContent = JSON.stringify(info, null, 2);

// State change log
const states = $("states");
const log: string[] = [];
rig.onStateChange = (names) => {
  const t = (performance.now() / 1000).toFixed(2);
  log.unshift(`${t}s  → ${names.join(", ")}`);
  states.textContent = log.slice(0, 12).join("\n");
};

// Mouth buttons
const mouths = $("mouths");
const tbody = document.querySelector("#mouthTable tbody")!;
for (const m of MOUTH_TABLE) {
  const b = document.createElement("button");
  b.textContent = `${m.id} ${m.shape}`;
  b.onclick = () => {
    rig.setInput(INPUT_MOUTH, m.id);
    for (const x of mouths.children) x.classList.toggle("on", x === b);
  };
  mouths.appendChild(b);
  const tr = document.createElement("tr");
  tr.innerHTML = `<td>${m.id}</td><td>${m.shape}</td><td>${m.phonemes}</td>`;
  tbody.appendChild(tr);
}

const ts = $<HTMLInputElement>("ts");
const tsv = $("tsv");
const syncTs = () => (tsv.textContent = String(rig.input(INPUT_MOUTH_SPEED)));
ts.value = String(rig.input(INPUT_MOUTH_SPEED) ?? 25);
syncTs();
ts.oninput = () => {
  rig.setInput(INPUT_MOUTH_SPEED, Number(ts.value));
  syncTs();
};

// Expression buttons (our emotion labels) + blink
const emotions = $("emotions");
for (const e of [...EMOTIONS, "listening" as const]) {
  const b = document.createElement("button");
  b.textContent = e;
  b.onclick = () => {
    rig.setExpression(e);
    for (const x of emotions.children) x.classList.toggle("on", x === b);
  };
  emotions.appendChild(b);
}
$("blink").onclick = () => rig.blink();
$<HTMLInputElement>("overrides").onchange = (ev) => (rig.overrides = (ev.target as HTMLInputElement).checked);

// Solo animation playback (includes "Timeline 2", the spec's "Timeline 29")
const anims = $("anims");
const stateBtn = document.createElement("button");
stateBtn.textContent = "State Machine 1";
stateBtn.classList.add("on");
anims.appendChild(stateBtn);
const animButtons = [stateBtn];
stateBtn.onclick = () => select(null, stateBtn);
for (const a of info.animations) {
  const b = document.createElement("button");
  b.textContent = `${a.name} (${a.seconds}s ${a.loop})`;
  b.onclick = () => select(a.name, b);
  anims.appendChild(b);
  animButtons.push(b);
}
function select(name: string | null, btn: HTMLButtonElement) {
  rig.playSolo(name);
  for (const x of animButtons) x.classList.toggle("on", x === btn);
}

// Lip-sync test with synthetic timing (~65 ms per letter) to preview the mapping.
$<HTMLFormElement>("saytest").onsubmit = (ev) => {
  ev.preventDefault();
  const text = $<HTMLInputElement>("sayText").value;
  const chars = [...text];
  const starts: number[] = [];
  const durs: number[] = [];
  let t = 0;
  for (const c of chars) {
    const d = /[a-z]/i.test(c) ? 65 : /[.,!?]/.test(c) ? 220 : 40;
    starts.push(t);
    durs.push(d);
    t += d;
  }
  const events = charsToVisemes(chars, starts, durs);
  const t0 = performance.now();
  rig.setActivity("speaking");
  const tick = () => {
    const ms = performance.now() - t0;
    if (ms > t + 150) {
      rig.setMouth(0, 22);
      rig.setActivity("idle");
      rig.setSpeechLevel(0);
      return;
    }
    rig.setMouth(visemeAt(events, ms), MOUTH_SPEED_TALKING);
    rig.setSpeechLevel(0.5 + 0.3 * Math.sin(ms / 90));
    requestAnimationFrame(tick);
  };
  tick();
};
