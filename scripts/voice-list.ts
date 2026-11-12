// npm run voice:list
// Lists the ElevenLabs voices available to your key, to pick a STOCK_VOICE_ID
// that sounds closest to the reference samples (casual, young, male, American).
import "dotenv/config";

const key = process.env.ELEVENLABS_API_KEY?.trim();
if (!key) {
  console.error("ELEVENLABS_API_KEY is missing in .env.");
  process.exit(1);
}
const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
if (!res.ok) {
  console.error(`ElevenLabs: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const { voices } = (await res.json()) as {
  voices: { voice_id: string; name: string; category?: string; labels?: Record<string, string>; preview_url?: string }[];
};
const score = (v: (typeof voices)[number]) => {
  const l = Object.values(v.labels ?? {}).join(" ").toLowerCase();
  return (l.includes("male") && !l.includes("female") ? 2 : 0) + (/casual|conversational|natural|chill|relaxed/.test(l) ? 2 : 0) + (/young|middle/.test(l) ? 1 : 0) + (/american/.test(l) ? 1 : 0);
};
voices.sort((a, b) => score(b) - score(a));
const current = process.env.VOICE_ID?.trim() || process.env.STOCK_VOICE_ID?.trim();
for (const v of voices) {
  const labels = Object.entries(v.labels ?? {}).map(([k, val]) => `${k}: ${val}`).join(", ");
  console.log(`${v.voice_id === current ? "*" : " "} ${v.voice_id}  ${v.name.padEnd(18)} [${v.category ?? ""}] ${labels}`);
  if (v.preview_url) console.log(`    preview: ${v.preview_url}`);
}
console.log("\nSet STOCK_VOICE_ID (fallback) or VOICE_ID (cloned) in .env to choose. * = in use.");
