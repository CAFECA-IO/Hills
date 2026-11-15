import { describe, expect, it } from 'vitest';
import type { AskAnswer } from './api';
import { applyEvent, historyOf, type AskMessage } from './kbask';

const msg = (p: Partial<AskMessage> = {}): AskMessage => ({
  askId: 1,
  question: 'q',
  scope: null,
  phase: 'understanding',
  intent: null,
  found: null,
  text: '',
  answer: null,
  error: null,
  prep: null,
  startedAt: 0,
  ...p,
});

const answer = (p: Partial<AskAnswer> = {}): AskAnswer => ({
  understood: { intent: 'kb', queries: ['q'], keywords: [] },
  answer: 'a [1]',
  citations: [],
  uncited: [],
  notFound: false,
  ...p,
});

describe('問知識庫狀態（D70）', () => {
  it('steps, tokens and done', () => {
    let m = applyEvent(msg(), {
      type: 'step',
      step: 'understood',
      intent: { intent: 'kb', queries: ['x'], keywords: [] },
    });
    expect(m.phase).toBe('searching');
    expect(applyEvent(msg(), { type: 'step', step: 'loading' }).prep).toEqual({ kind: 'loading' });
    m = applyEvent(m, { type: 'step', step: 'found', items: 2, pdfs: 1 });
    expect(m.found).toEqual({ items: 2, pdfs: 1 });
    m = applyEvent(m, { type: 'token', text: '不會' });
    m = applyEvent(m, { type: 'token', text: '不見' });
    expect(m.text).toBe('不會不見');
    expect(m.phase).toBe('answering');
    m = applyEvent(m, { type: 'done', answer: answer() });
    expect(m.phase).toBe('done');
    expect(applyEvent(m, { type: 'done', answer: answer({ notFound: true }) }).phase).toBe(
      'notFound',
    );
    expect(applyEvent(m, { type: 'error', message: 'x', cancelled: true }).phase).toBe('cancelled');
  });
  it('history keeps the last 3 answered turns', () => {
    const done = (q: string) => msg({ question: q, phase: 'done', answer: answer({ answer: q }) });
    const h = historyOf([
      done('1'),
      done('2'),
      msg({ phase: 'notFound', answer: answer({ notFound: true, answer: '' }) }),
      done('3'),
      done('4'),
    ]);
    expect(h.map((t) => t.question)).toEqual(['2', '3', '4']);
  });
});
