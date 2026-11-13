// Group avatars, drawn as herdr-app draws its spaces: a colored square with the space's
// first letter. The caller gives each space one color, so all of its groups look alike.
// The SVG is turned into a PNG by sips (macOS); where that fails, the caller leaves the
// group with Feishu's default avatar.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const COLORS = ['#3f9e8f', '#d9824b', '#5b7fe0', '#8a6fd6', '#4fa35a', '#d0605e', '#c99a2e', '#3f8fc0'];
const SIZE = 240;
const FONT = 130;

export function letterOf(space) {
  return (Array.from(space.trim())[0] || '?').toUpperCase();
}

const escapeXml = (s) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function avatarPng(letter, color) {
  // sips ignores dominant-baseline: the baseline sits half a cap height below the middle
  const baseline = Math.round(SIZE / 2 + FONT * 0.36);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><rect width="${SIZE}" height="${SIZE}" fill="${color}"/><text x="${SIZE / 2}" y="${baseline}" font-family="Helvetica Neue, Helvetica, Arial" font-weight="600" font-size="${FONT}" fill="#ffffff" text-anchor="middle">${escapeXml(letter)}</text></svg>`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdrchat-avatar-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.svg'), svg);
    await new Promise((resolve, reject) => {
      execFile('sips', ['-s', 'format', 'png', path.join(dir, 'a.svg'), '--out', path.join(dir, 'a.png')], (err) => (err ? reject(err) : resolve()));
    });
    return fs.readFileSync(path.join(dir, 'a.png'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
