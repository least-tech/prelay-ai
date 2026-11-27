import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

export const languages = ['English', 'Traditional Chinese', 'Simplified Chinese', 'Korean'];
export const instructions = 'Localize the source for each selected language. Use natural wording for the local audience and match the brand tone. Preserve offer terms, dates, numbers, names, and required facts. Keep the call to action clear. Use a separate labeled section for each language. Flag ambiguity instead of inventing details.';
const derive = promisify(scrypt);

export class Problem extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const bad = (message) => { throw new Problem(400, message); };
export const notFound = () => { throw new Problem(404, 'This item is unavailable.'); };
export const forbidden = () => { throw new Problem(403, 'You do not have permission for this action.'); };
export const sha = (value) => createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export const now = () => Date.now();
export const day = 86_400_000;

export function field(value, label, limit, required = true) {
  const text = typeof value === 'string' ? value.trim() : '';
  if ((!text && required) || text.length > limit || text.includes('\0')) bad(label + ' must ' + (required ? 'contain 1–' : 'contain at most ') + limit + ' characters.');
  return text;
}

export function emailAddress(value) {
  const result = field(value, 'Email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(result)) bad('Enter a valid email address.');
  return result;
}

export function number(value, label, { max = 1e9, integer = false, optional = true } = {}) {
  const text = String(value ?? '').trim();
  if (!text && optional) return null;
  const parsed = Number(text);
  if (!/^\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(parsed) || parsed > max || (integer && !Number.isSafeInteger(parsed))) bad(label + ' is invalid.');
  return parsed;
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) bad('Use a password between 12 and 256 characters.');
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + Buffer.from(await derive(password, salt, 64)).toString('hex');
}

export async function passwordMatches(password, hash) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const [salt, encoded] = (hash || '00000000000000000000000000000000:' + '0'.repeat(128)).split(':');
  const actual = Buffer.from(await derive(password, salt, 64));
  return timingSafeEqual(actual, Buffer.from(encoded, 'hex')) && Boolean(hash);
}

export function inputFrom(form) {
  const chosen = [...new Set(form.getAll('language'))];
  if (chosen.some((lang) => !languages.includes(lang))) bad('Select supported languages.');
  if (!chosen.length) bad('Select at least one target language.');
  return {
    source: field(form.get('source'), 'Source copy', 12000),
    audience: field(form.get('audience'), 'Audience', 1000),
    tone: field(form.get('tone'), 'Brand tone', 1000),
    terms: field(form.get('terms'), 'Required facts or terms', 3000, false),
    languages: chosen
  };
}

export function deriveInstructions(examples) {
  const content = field(examples, 'Examples', 12000);
  const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const format = lines.filter(line => /^(?:[-*•]|\d+[.)])\s/u.test(line)).length >= 2
    ? 'Use short bullets for benefits or steps where the source supports them.'
    : 'Use concise paragraphs. Keep the lead and call to action easy to scan.';
  const length = lines.map(line => Array.from(line).length).sort((a,b) => a-b)[Math.floor(lines.length / 2)];
  const style = /\p{Extended_Pictographic}/u.test(content)
    ? 'Use emoji sparingly where appropriate for the channel and brand.'
    : 'Keep punctuation restrained and omit emoji unless requested.';
  const headings = lines.some(line => /^(?:#+\s|[^:：]{1,24}[:：]\s*$)/u.test(line))
    ? 'Use short headings to separate sections.' : 'Use the locale label as the main heading.';
  return [instructions, format, style, headings, length < 90 ? 'Favor short lines for mobile reading.' : 'Allow fuller sentences where detail is needed.'].join('\n');
}

export function metrics(jobs) {
  const approved = jobs.filter(job => job.approved);
  const measured = approved.filter(job => job.minutes != null);
  const elapsed = approved.filter(job => job.elapsed != null);
  const reviewed = jobs.filter(job => job.reviewed && job.revisions != null);
  const mean = (items, key) => items.length ? items.reduce((sum, item) => sum + item[key], 0) / items.length : null;
  return {
    total: jobs.length, approved: approved.length, measured: measured.length, reviewed: reviewed.length,
    average: mean(measured,'minutes'), elapsed: mean(elapsed,'elapsed'), elapsedCount: elapsed.length,
    firstPass: reviewed.length ? reviewed.filter(job => job.approved && job.revisions === 0).length / reviewed.length : null
  };
}
