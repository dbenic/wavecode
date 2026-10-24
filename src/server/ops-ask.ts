/**
 * Classify an "ask for data" question.
 * A change, write, or delete waits for an owner. A read goes to the scout.
 * Nothing in this file runs a query.
 */

const MUTATION_RE = /\b(?:change|update|modify|alter|delete|remove|erase|drop|overwrite|insert|truncate|write|create|destroy|purge|wipe|upsert)\b/i;

export function asksToChangeData(question: string): boolean {
  return MUTATION_RE.test(question);
}
