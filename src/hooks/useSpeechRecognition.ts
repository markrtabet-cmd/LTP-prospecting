"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      [index: number]: { transcript: string };
    };
  };
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

type SpeechWindow = Window & {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
};

export function useSpeechRecognition({
  onFinal,
  lang = "en-GB",
}: {
  onFinal?: (text: string) => void;
  lang?: string;
} = {}) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const wantRef = useRef(false);
  const discardRef = useRef(false);
  const finalRef = useRef("");
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const SR = (window as SpeechWindow).SpeechRecognition || (window as SpeechWindow).webkitSpeechRecognition;
    if (!SR) {
      setSupported(false);
      return;
    }

    let rec: SpeechRecognitionLike;
    try {
      rec = new SR();
    } catch {
      setSupported(false);
      return;
    }

    setSupported(true);
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = lang;

    rec.onresult = (event) => {
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalRef.current = `${finalRef.current} ${transcript}`.trim();
        } else {
          interimText += transcript;
        }
      }
      setInterim(`${finalRef.current} ${interimText}`.trim());
    };

    rec.onerror = (event) => {
      const code = event.error;
      if (code === "not-allowed" || code === "service-not-allowed") {
        setError("Microphone access is blocked.");
        wantRef.current = false;
      } else if (code === "network") {
        setError("Voice recognition needs a network connection.");
        wantRef.current = false;
      } else if (code && code !== "no-speech" && code !== "aborted") {
        setError(`Voice input error: ${code}.`);
      }
    };

    rec.onend = () => {
      if (wantRef.current) {
        try {
          rec.start();
        } catch {
          setTimeout(() => {
            if (wantRef.current) {
              try {
                rec.start();
              } catch {
                /* ignore */
              }
            }
          }, 250);
        }
        return;
      }

      setListening(false);
      const discard = discardRef.current;
      discardRef.current = false;
      const full = finalRef.current.trim();
      finalRef.current = "";
      setInterim("");
      if (!discard && full) onFinalRef.current?.(full);
    };

    recRef.current = rec;
    return () => {
      wantRef.current = false;
      try {
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        rec.abort();
      } catch {
        /* ignore */
      }
      recRef.current = null;
    };
  }, [lang]);

  const start = useCallback(() => {
    const rec = recRef.current;
    if (!rec || wantRef.current) return;
    setError(null);
    setInterim("");
    finalRef.current = "";
    discardRef.current = false;
    wantRef.current = true;
    try {
      rec.start();
      setListening(true);
    } catch {
      wantRef.current = false;
      setListening(false);
    }
  }, []);

  const stop = useCallback(() => {
    const rec = recRef.current;
    wantRef.current = false;
    if (!rec) return;
    try {
      rec.stop();
    } catch {
      /* ignore */
    }
  }, []);

  const cancel = useCallback(() => {
    const rec = recRef.current;
    discardRef.current = true;
    wantRef.current = false;
    finalRef.current = "";
    setInterim("");
    if (rec) {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    }
    setListening(false);
  }, []);

  const restart = useCallback(() => {
    finalRef.current = "";
    setInterim("");
    if (!wantRef.current) start();
  }, [start]);

  const toggle = useCallback(() => {
    if (wantRef.current) stop();
    else start();
  }, [start, stop]);

  return { supported, listening, interim, error, start, stop, cancel, restart, toggle };
}
