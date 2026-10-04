'use client';

import { ImageOff } from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { safeHref } from '@/lib/format';
import { buildEmailDocument, sanitizeEmailHtml } from '@/lib/sanitize';
import type { Message } from '@/lib/types';

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;

/** Plain text with http(s) links made clickable. Everything else stays text. */
export function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, index) => {
        if (index % 2 === 1) {
          const href = safeHref(part);
          if (href) {
            return (
              <a key={index} href={href} target="_blank" rel="noopener noreferrer nofollow">
                {part}
              </a>
            );
          }
        }
        return <Fragment key={index}>{part}</Fragment>;
      })}
    </>
  );
}

/** Splits a text body into the reply and the quoted history beneath it. */
function splitQuoted(text: string): Array<{ quoted: boolean; text: string }> {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: Array<{ quoted: boolean; lines: string[] }> = [];
  for (const line of lines) {
    const quoted = line.startsWith('>');
    const last = blocks[blocks.length - 1];
    if (last && last.quoted === quoted) last.lines.push(line);
    else if (last && last.quoted && line.trim() === '') last.lines.push(line);
    else blocks.push({ quoted, lines: [line] });
  }
  // Pull the "On … wrote:" attribution into the quote it introduces.
  for (let i = 1; i < blocks.length; i += 1) {
    const prev = blocks[i - 1]!;
    if (!blocks[i]!.quoted || prev.quoted) continue;
    while (prev.lines.length && prev.lines[prev.lines.length - 1]!.trim() === '') prev.lines.pop();
    const tail = prev.lines[prev.lines.length - 1];
    if (tail && /wrote:\s*$/.test(tail)) blocks[i]!.lines.unshift(prev.lines.pop()!);
  }
  return blocks
    .map((block) => ({ quoted: block.quoted, text: block.lines.join('\n').replace(/\s+$/, '') }))
    .filter((block) => block.text.length > 0);
}

function PlainBody({ text }: { text: string }) {
  const blocks = useMemo(() => splitQuoted(text), [text]);
  const out: ReactNode[] = [];
  blocks.forEach((block, index) => {
    if (block.quoted) {
      out.push(
        <details key={index} className="quoted">
          <summary>Quoted text</summary>
          <div className="mailtext mailtext--quoted">
            <Linkified text={block.text} />
          </div>
        </details>,
      );
    } else {
      out.push(
        <div key={index} className="mailtext">
          <Linkified text={block.text} />
        </div>,
      );
    }
  });
  return <>{out}</>;
}

function EmailFrame({ html, allowImages, title }: { html: string; allowImages: boolean; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(96);
  const srcDoc = useMemo(() => buildEmailDocument(html, allowImages, window.location.origin), [html, allowImages]);

  const measure = useCallback(() => {
    const body = ref.current?.contentDocument?.body;
    if (!body) return;
    const next = Math.ceil(Math.max(body.scrollHeight, body.offsetHeight)) + 4;
    setHeight((current) => (Math.abs(current - next) > 1 ? next : current));
  }, []);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;
    const onLoad = () => {
      measure();
      const body = frame.contentDocument?.body;
      if (body && typeof ResizeObserver !== 'undefined') {
        observer?.disconnect();
        observer = new ResizeObserver(measure);
        observer.observe(body);
      }
    };
    frame.addEventListener('load', onLoad);
    if (frame.contentDocument?.readyState === 'complete') onLoad();
    return () => {
      frame.removeEventListener('load', onLoad);
      observer?.disconnect();
    };
  }, [measure, srcDoc]);

  return (
    <iframe
      ref={ref}
      className="mailframe"
      title={title}
      // No allow-scripts: nothing inside can execute. Same-origin is only so the
      // parent can measure the content height.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      style={{ height }}
    />
  );
}

export function MessageBody({ message, loadImages }: { message: Message; loadImages: boolean }) {
  const [showImages, setShowImages] = useState(loadImages);
  const prepared = useMemo(
    () => (message.bodyHtml ? sanitizeEmailHtml(message.bodyHtml, showImages) : null),
    [message.bodyHtml, showImages],
  );

  if (!prepared) {
    const text = message.bodyText ?? '';
    if (!text.trim()) return <p className="mailtext mailtext--empty">This message has no text content.</p>;
    return <PlainBody text={text} />;
  }

  return (
    <>
      {prepared.blockedImages > 0 && !showImages && (
        <div className="imgblock" role="status">
          <ImageOff size={14} aria-hidden="true" />
          <span>
            {prepared.blockedImages === 1 ? 'One remote image is' : `${prepared.blockedImages} remote images are`} hidden so
            the sender can’t tell that you opened this.
          </span>
          <button type="button" className="link-btn" onClick={() => setShowImages(true)}>
            Show images
          </button>
        </div>
      )}
      <EmailFrame html={prepared.html} allowImages={showImages} title={`Message from ${message.from.name ?? message.from.email}`} />
    </>
  );
}
