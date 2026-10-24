/**
 * Classify an "ask for data" question.
 * An explicit write, or any change/write/delete stem, waits for an owner.
 * Only an explicit read with no stem hit goes to the scout.
 * Nothing in this file runs a query.
 */

/** Word-start stems. A longer word that merely continues the stem still counts, except payroll. */
const WRITE_STEMS = [
  'overwrit', 'truncat', 'spremen', 'popravi', 'posodob', 'promijen', 'insert', 'cancel',
  'correct', 'import', 'approv', 'storno', 'revers', 'renam', 'creat', 'modif', 'updat',
  'delet', 'remov', 'chang', 'merg', 'knjiž', 'knjiz', 'izbri', 'obriš', 'obris', 'dodaj',
  'storn', 'uvoz', 'briš', 'bris', 'writ', 'post', 'book', 'void', 'edit', 'send', 'drop',
  'mov', 'pay', 'set', 'add', 'fix',
] as const;

const WORD_RE = /\p{L}+/gu;

function wordIsWrite(word: string): boolean {
  const lower = word.toLowerCase();
  if (lower.startsWith('payroll')) return false;
  return WRITE_STEMS.some((stem) => lower.startsWith(stem));
}

/** True when any word starts with a change, write, or delete stem. */
export function asksToChangeData(question: string): boolean {
  return (question.match(WORD_RE) ?? []).some(wordIsWrite);
}

export type AskIntent = 'read' | 'write';

/** Missing intent is read. Anything else is rejected by the route. */
export function parseAskIntent(value: unknown): AskIntent | null {
  if (value === undefined || value === null || value === '') return 'read';
  if (value === 'read' || value === 'write') return value;
  return null;
}

/** Write, or any stem hit, needs the owner. A clean explicit read does not. */
export function askNeedsOwner(question: string, intent: AskIntent): boolean {
  return intent === 'write' || asksToChangeData(question);
}
