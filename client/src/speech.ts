// Free speech-to-text with the browser's Web Speech API (Chrome / Edge).
// Continuous with interim results; restarts itself when the browser ends a session.

interface RecResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecEvent {
  resultIndex: number;
  results: ArrayLike<RecResult>;
}
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: RecEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

const Ctor = (window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition;

export class BrowserSpeech {
  private rec: Recognition | null = null;
  private wanted = false;

  static get supported() {
    return !!Ctor;
  }

  constructor(
    private onResult: (text: string, isFinal: boolean) => void,
    private onError: (message: string) => void,
  ) {}

  start() {
    if (!Ctor || this.wanted) return;
    this.wanted = true;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        const text = r[0].transcript.trim();
        if (!text) continue;
        if (r.isFinal) this.onResult(text, true);
        else interim += `${text} `;
      }
      if (interim.trim()) this.onResult(interim.trim(), false);
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.wanted = false;
        this.onError("Speech recognition was blocked. Allow the microphone, or type below.");
      } else if (e.error === "network") {
        this.onError("Speech recognition needs an internet connection (the browser's service). Retrying…");
      }
      // "no-speech" and "aborted" are normal; onend restarts
    };
    rec.onend = () => {
      if (this.wanted) setTimeout(() => this.wanted && this.safeStart(), 150);
    };
    this.rec = rec;
    this.safeStart();
  }

  stop() {
    this.wanted = false;
    this.rec?.abort();
    this.rec = null;
  }

  private safeStart() {
    try {
      this.rec?.start();
    } catch {
      /* already started */
    }
  }
}
