import { Badge, Check, Countdown, Hash, Mono, Row, Rows } from '@paperseal/ui';
import type { ReactNode } from 'react';

import type { Item, Label } from './custody';

const nameOf = (label: Label) => (typeof label === 'string' ? label : label.code);
const text = (label: Label) => (typeof label === 'string' ? label : <Mono>{label.code}</Mono>);

const isRow = (item: Item) => item.kind === 'check' || item.kind === 'hash' || item.kind === 'fact' || item.kind === 'tag';

function RowFor({ item }: { item: Item }) {
  switch (item.kind) {
    case 'check':
      return (
        <Row label={text(item.label)}>
          <Check status={item.status}>{item.detail}</Check>
          {item.hash ? <Hash value={item.hash} label={nameOf(item.label)} /> : null}
        </Row>
      );
    case 'hash':
      return (
        <Row label={text(item.label)}>
          <Hash value={item.value} label={nameOf(item.label)} />
        </Row>
      );
    case 'fact':
      return <Row label={text(item.label)}>{item.value}</Row>;
    case 'tag':
      return (
        <Row label={text(item.label)}>
          {item.value ? `${item.value} ` : ''}
          <Badge tone={item.tone}>{item.tag}</Badge>
          {item.hash ? <Hash value={item.hash} label={nameOf(item.label)} /> : null}
        </Row>
      );
    default:
      return null;
  }
}

function Block({ item }: { item: Item }) {
  switch (item.kind) {
    case 'heading':
      return <h3 className="vf-evidence-heading">{item.text}</h3>;
    case 'text':
      return (
        <p className="vf-evidence-text" data-tone={item.tone}>
          {item.tone === 'warn' ? <Badge tone="warn">Note</Badge> : null} {item.text}
        </p>
      );
    case 'countdown':
      return <Countdown at={item.at} round={item.round} label={item.label} reached={item.reached} locale="en-GB" />;
    case 'code':
      return (
        <pre className="vf-code">
          <code>{item.text}</code>
        </pre>
      );
    case 'link':
      return (
        <p className="vf-evidence-text">
          <a href={item.href} target="_blank" rel="noreferrer">
            {item.text}
          </a>
        </p>
      );
    default:
      return null;
  }
}

/** A step's evidence: runs of ledger rows, with any notes and headings between them. */
export function Evidence({ items }: { items: readonly Item[] }) {
  const parts: ReactNode[] = [];
  let run: Item[] = [];
  const flush = () => {
    if (run.length === 0) return;
    parts.push(
      <Rows key={parts.length}>
        {run.map((item, index) => (
          <RowFor key={index} item={item} />
        ))}
      </Rows>,
    );
    run = [];
  };
  for (const item of items) {
    if (isRow(item)) {
      run.push(item);
    } else {
      flush();
      parts.push(<Block key={parts.length} item={item} />);
    }
  }
  flush();
  return <>{parts}</>;
}
