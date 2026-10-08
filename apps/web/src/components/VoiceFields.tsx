'use client';

import { Upload } from 'lucide-react';
import { useRef, useState } from 'react';

export interface Voice {
  voice: string;
  about: string;
}

const TONES: Array<{ label: string; text: string }> = [
  { label: 'Direct', text: 'Short and direct. Lead with the answer. No filler, no pleasantries beyond a greeting.' },
  { label: 'Warm', text: 'Warm and personal. Friendly openers, plain words, and a human sign-off.' },
  { label: 'Formal', text: 'Polished and professional. Full sentences, measured tone, no slang.' },
  { label: 'Casual', text: 'Relaxed and conversational, like texting a colleague. Contractions and short lines are fine.' },
];

const MAX_FILE_BYTES = 200_000;

/**
 * How the agent should sound and who it is writing for. The voice box takes
 * anything: a voice skill file, a tone guide, a full persona prompt.
 */
export function VoiceFields({ value, onChange, disabled }: { value: Voice; onChange: (next: Voice) => void; disabled?: boolean }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setProblem('That file is too large to be a voice guide. Paste the relevant part instead.');
      return;
    }
    try {
      const text = (await file.text()).trim();
      setProblem(null);
      onChange({ ...value, voice: text.slice(0, 12_000) });
    } catch {
      setProblem('That file could not be read as text.');
    }
  };

  return (
    <div className="voice">
      <div className="field">
        <div className="voice__label">
          <label className="field__label" htmlFor="voice-guide">
            Your voice
          </label>
          <button type="button" className="voice__file" disabled={disabled} onClick={() => fileRef.current?.click()}>
            <Upload size={12} aria-hidden="true" /> Load a file
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".md,.txt,.markdown,text/plain,text/markdown"
            hidden
            onChange={(event) => {
              void load(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </div>
        <textarea
          id="voice-guide"
          className="input voice__box"
          rows={7}
          maxLength={12_000}
          placeholder="Paste a voice skill, a tone guide or a persona prompt. Or pick a starting point below."
          value={value.voice}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, voice: event.target.value })}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            const file = event.dataTransfer.files?.[0];
            if (file) {
              event.preventDefault();
              void load(file);
            }
          }}
        />
        {problem ? (
          <span className="field__error" role="alert">
            {problem}
          </span>
        ) : (
          !value.voice.trim() && (
            <div className="voice__tones" role="group" aria-label="Starting points">
              <span>Start from</span>
              {TONES.map((tone) => (
                <button key={tone.label} type="button" className="voice__tone" disabled={disabled} onClick={() => onChange({ ...value, voice: tone.text })}>
                  {tone.label}
                </button>
              ))}
            </div>
          )
        )}
      </div>

      <div className="field">
        <label className="field__label" htmlFor="voice-about">
          About you
        </label>
        <textarea
          id="voice-about"
          className="input"
          rows={3}
          maxLength={4000}
          placeholder="What you do, who matters most, what you never want to miss."
          value={value.about}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, about: event.target.value })}
        />
      </div>
    </div>
  );
}
