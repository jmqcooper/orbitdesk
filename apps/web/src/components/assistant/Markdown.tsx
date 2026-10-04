'use client';

import { Fragment, type ReactNode } from 'react';
import { safeHref } from '@/lib/format';

/**
 * Renders the small markdown subset the assistant is allowed to use into React
 * elements. No HTML is ever injected; unknown syntax stays as plain text.
 */

const INLINE =
  /(\*\*[^*\n]+\*\*)|(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\s]+\))|(\*[^*\s][^*\n]*\*)|(https?:\/\/[^\s<>"')\]]+)/g;

function inline(text: string, depth = 0): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) out.push(<Fragment key={key++}>{text.slice(last, index)}</Fragment>);
    const token = match[0];
    if (match[1]) {
      out.push(<strong key={key++}>{depth < 2 ? inline(token.slice(2, -2), depth + 1) : token.slice(2, -2)}</strong>);
    } else if (match[2]) {
      out.push(<code key={key++}>{token.slice(1, -1)}</code>);
    } else if (match[3]) {
      const parts = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const href = parts ? safeHref(parts[2]) : null;
      if (parts && href) {
        out.push(
          <a key={key++} href={href} target="_blank" rel="noopener noreferrer nofollow">
            {parts[1]}
          </a>,
        );
      } else {
        out.push(<Fragment key={key++}>{parts ? parts[1] : token}</Fragment>);
      }
    } else if (match[4]) {
      out.push(<em key={key++}>{depth < 2 ? inline(token.slice(1, -1), depth + 1) : token.slice(1, -1)}</em>);
    } else {
      const href = safeHref(token);
      out.push(
        href ? (
          <a key={key++} href={href} target="_blank" rel="noopener noreferrer nofollow">
            {token}
          </a>
        ) : (
          <Fragment key={key++}>{token}</Fragment>
        ),
      );
    }
    last = index + token.length;
  }
  if (last < text.length) out.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return out;
}

type Block =
  | { type: 'p'; lines: string[] }
  | { type: 'h'; level: 2 | 3 | 4; text: string }
  | { type: 'ul' | 'ol'; items: string[] }
  | { type: 'quote'; lines: string[] }
  | { type: 'code'; text: string }
  | { type: 'hr' };

function parse(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (line.trimStart().startsWith('```')) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trimStart().startsWith('```')) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1;
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(4, Math.max(2, heading[1]!.length + 1)) as 2 | 3 | 4;
      blocks.push({ type: 'h', level, text: heading[2]! });
      i += 1;
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/;
    const numbered = /^\s*\d+[.)]\s+(.*)$/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const pattern = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i]!;
        const item = pattern.exec(current);
        if (item) items.push(item[1]!);
        else if (current.trim() && /^\s{2,}/.test(current) && items.length) items[items.length - 1] += ` ${current.trim()}`;
        else break;
        i += 1;
      }
      blocks.push({ type: ordered ? 'ol' : 'ul', items });
      continue;
    }
    if (line.startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>')) {
        body.push(lines[i]!.replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'quote', lines: body });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,4})\s+/.test(lines[i]!) &&
      !bullet.test(lines[i]!) &&
      !numbered.test(lines[i]!) &&
      !lines[i]!.startsWith('>') &&
      !lines[i]!.trimStart().startsWith('```')
    ) {
      para.push(lines[i]!);
      i += 1;
    }
    blocks.push({ type: 'p', lines: para });
  }
  return blocks;
}

function withBreaks(lines: string[]): ReactNode[] {
  const out: ReactNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) out.push(<br key={`br-${index}`} />);
    out.push(<Fragment key={`line-${index}`}>{inline(line)}</Fragment>);
  });
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks = parse(text);
  return (
    <div className="md">
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'h': {
            const Tag = `h${block.level}` as 'h2' | 'h3' | 'h4';
            return <Tag key={index}>{inline(block.text)}</Tag>;
          }
          case 'ul':
            return (
              <ul key={index}>
                {block.items.map((item, n) => (
                  <li key={n}>{inline(item)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={index}>
                {block.items.map((item, n) => (
                  <li key={n}>{inline(item)}</li>
                ))}
              </ol>
            );
          case 'quote':
            return <blockquote key={index}>{withBreaks(block.lines)}</blockquote>;
          case 'code':
            return (
              <pre key={index}>
                <code>{block.text}</code>
              </pre>
            );
          case 'hr':
            return <hr key={index} />;
          default:
            return <p key={index}>{withBreaks(block.lines)}</p>;
        }
      })}
    </div>
  );
}
