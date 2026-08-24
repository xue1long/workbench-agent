#!/usr/bin/env node
// scripts/check-commit-msg.mjs — verify a commit message follows Conventional
// Commits. Reads the message from $1 (file path) or stdin.
//
// Usage:
//   node scripts/check-commit-msg.mjs .git/COMMIT_EDITMSG
//   git log -1 --pretty=%B | node scripts/check-commit-msg.mjs
//
// Allowed type values match CONTRIBUTING.md. Subject ≤ 72 chars.

import fs from 'node:fs';

const ALLOWED_TYPES = new Set(['feat', 'fix', 'refactor', 'test', 'docs', 'chore', 'perf']);
const SUBJECT_MAX = 72;

function readMessage() {
  if (process.argv[2]) {
    const path = process.argv[2];
    if (!fs.existsSync(path)) {
      process.stderr.write(`check-commit-msg: file not found: ${path}\n`);
      process.exit(1);
    }
    return fs.readFileSync(path, 'utf8');
  }
  return fs.readFileSync(0, 'utf8');
}

function stripComments(msg) {
  // git commit messages can include "# This is a comment" lines (after --amend,
  // or when the editor strips the previous message). Drop lines starting with #.
  return msg.split('\n').filter((line) => !line.startsWith('#')).join('\n');
}

function validate(message) {
  const errors = [];
  const text = stripComments(message).trim();
  if (text.length === 0) {
    return ['commit message is empty'];
  }
  const lines = text.split('\n');
  const subject = lines[0];
  if (subject.length > SUBJECT_MAX) {
    errors.push(`subject ${subject.length} chars exceeds ${SUBJECT_MAX}`);
  }
  const match = /^([a-z]+)(?:\([^)]+\))?!?: (.+)$/.exec(subject);
  if (!match) {
    errors.push(`subject "${subject}" must be "<type>(<optional-scope>): <subject>" (Conventional Commits)`);
    return errors;
  }
  const [, type, rest] = match;
  if (!ALLOWED_TYPES.has(type)) {
    errors.push(`type "${type}" is not in the allow-list: ${[...ALLOWED_TYPES].join(', ')}`);
  }
  if (rest.trim().length === 0) {
    errors.push('subject is empty after the type prefix');
  }
  if (subject !== subject.trim()) {
    errors.push('subject has leading or trailing whitespace');
  }
  if (/[A-Z]/.test(subject.split(':')[0])) {
    errors.push('subject prefix should be lowercase');
  }
  return errors;
}

const message = readMessage();
const errors = validate(message);
if (errors.length > 0) {
  for (const e of errors) process.stderr.write(`check-commit-msg: ${e}\n`);
  process.exit(1);
}
process.stdout.write('check-commit-msg: ok\n');
