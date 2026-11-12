// npm run voice:create [-- --force]
//
// Creates the character's voice ONCE with ElevenLabs Instant Voice Cloning from
// voice-samples/prepared/*.wav and stores the returned id as VOICE_ID in .env.
// Every conversation reuses that id; nothing is cloned per request.
//
// Consent: cloning is refused unless VOICE_CLONE_CONSENT=yes, which you set only
// if you own the voice or have the speaker's permission. ElevenLabs may also ask
// for its own verification; complete it in their dashboard, don't work around it.
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import "dotenv/config";

const PREPARED = join("voice-samples", "prepared");
const force = process.argv.includes("--force");
const key = process.env.ELEVENLABS_API_KEY?.trim();
const consent = (process.env.VOICE_CLONE_CONSENT ?? "").trim().toLowerCase();
const existing = process.env.VOICE_ID?.trim();
const name = process.env.VOICE_NAME?.trim() || "Character voice";

if (!key) fail("ELEVENLABS_API_KEY is missing in .env.");
if (existing && !force) {
  console.log(`VOICE_ID is already set (${existing}); reusing it. Pass -- --force to create a new voice from the current samples.`);
  process.exit(0);
}
if (consent !== "yes") {
  fail(
    [
      "Not cloning: VOICE_CLONE_CONSENT is not \"yes\".",
      "Only clone a voice you own or have the speaker's permission to use.",
      "If you do, set VOICE_CLONE_CONSENT=yes in .env and run this again.",
      "Until then the character uses the stock voice in STOCK_VOICE_ID (see `npm run voice:list`).",
    ].join("\n"),
  );
}
if (!existsSync(PREPARED)) fail("No prepared samples. Run `npm run voice:prepare` first.");
const wavs = readdirSync(PREPARED).filter((f) => f.endsWith(".wav"));
if (!wavs.length) fail("No accepted samples in voice-samples/prepared. Run `npm run voice:prepare` and check its report.");

const form = new FormData();
form.append("name", name);
form.append("description", "Casual, blunt, funny delivery. Created from voice-samples/ by voice:create.");
form.append("labels", JSON.stringify({ source: "voice-samples", style: "casual" }));
form.append("remove_background_noise", "false"); // prepare already rejected noisy clips
for (const f of wavs) {
  const bytes = readFileSync(join(PREPARED, f));
  form.append("files", new Blob([bytes], { type: "audio/wav" }), f);
}
console.log(`Uploading ${wavs.length} sample(s): ${wavs.map((f) => basename(f, ".wav")).join(", ")}`);

const res = await fetch("https://api.elevenlabs.io/v1/voices/add", {
  method: "POST",
  headers: { "xi-api-key": key! },
  body: form,
});
const body = (await res.json().catch(() => ({}))) as { voice_id?: string; requires_verification?: boolean; detail?: unknown };
if (!res.ok || !body.voice_id) fail(`ElevenLabs refused the clone (${res.status}): ${JSON.stringify(body.detail ?? body)}`);

writeEnv("VOICE_ID", body.voice_id!);
console.log(`Created voice ${body.voice_id} and saved it as VOICE_ID in .env.`);
if (body.requires_verification) {
  console.log("ElevenLabs requires verification for this voice: finish it in the ElevenLabs dashboard (Voices → your voice) before it can speak.");
}
console.log("Restart the server to use it.");

function writeEnv(k: string, v: string) {
  if (!existsSync(".env")) copyFileSync(".env.example", ".env");
  const lines = readFileSync(".env", "utf8").split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith(`${k}=`));
  if (i >= 0) lines[i] = `${k}=${v}`;
  else lines.push(`${k}=${v}`);
  writeFileSync(".env", lines.join("\n"));
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
