import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { MIME_TYPES, mimeFor } from '../src/upload-mime.js';

// Expected values are written out independently of MIME_TYPES so the table is
// actually verified rather than compared with itself. This doubles as the
// contract the wiring in server.js / tools.js must honour.
const EXPECTED = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ofd': 'application/ofd',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/csv'
};

test('MIME_TYPES is a plain lowercase table covering every required type', () => {
  for (const [ext, mime] of Object.entries(EXPECTED)) {
    assert.equal(MIME_TYPES[ext], mime, ext + ' must map to ' + mime);
  }
  for (const ext of Object.keys(MIME_TYPES)) {
    assert.match(ext, /^\.[a-z0-9]+$/, ext + ' must be a lowercase dotted extension');
  }
  for (const mime of Object.values(MIME_TYPES)) {
    assert.match(mime, /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/, mime + ' must look like type/subtype');
  }
});

test('the four pre-existing server.js values are preserved unchanged', () => {
  assert.equal(MIME_TYPES['.zip'], 'application/zip');
  assert.equal(MIME_TYPES['.json'], 'application/json');
  assert.equal(MIME_TYPES['.txt'], 'text/plain');
  assert.equal(MIME_TYPES['.csv'], 'text/csv');
});

test('mimeFor resolves every table extension with source extension', () => {
  for (const [ext, mime] of Object.entries(EXPECTED)) {
    const result = mimeFor('document' + ext);
    assert.equal(result.mimeType, mime);
    assert.equal(result.source, 'extension');
    assert.equal(result.extension, ext);
  }
});

test('unknown and extension-less paths fall back to application/octet-stream', () => {
  assert.deepEqual(mimeFor('archive.unknown'), {
    mimeType: 'application/octet-stream', source: 'fallback', extension: '.unknown'
  });
  assert.deepEqual(mimeFor('README'), {
    mimeType: 'application/octet-stream', source: 'fallback', extension: ''
  });
  // a dot inside a directory component must not be mistaken for an extension
  assert.deepEqual(mimeFor('dir.name/file'), {
    mimeType: 'application/octet-stream', source: 'fallback', extension: ''
  });
});

test('extension is normalised to lowercase regardless of input case', () => {
  const pdf = mimeFor('SCAN.PDF');
  assert.equal(pdf.extension, '.pdf');
  assert.equal(pdf.mimeType, 'application/pdf');
  assert.equal(pdf.source, 'extension');
  const docx = mimeFor('report.DocX');
  assert.equal(docx.extension, '.docx');
  assert.equal(docx.mimeType, EXPECTED['.docx']);
  assert.equal(mimeFor('PHOTO.JPEG').extension, '.jpeg');
});

test('an explicit valid MIME wins and reports source explicit', () => {
  assert.deepEqual(mimeFor('a.pdf', 'image/png'), {
    mimeType: 'image/png', source: 'explicit', extension: '.pdf'
  });
  // surrounding whitespace is trimmed, the value is otherwise returned as-is
  assert.deepEqual(mimeFor('a.txt', '  Application/X-Custom+Thing  '), {
    mimeType: 'Application/X-Custom+Thing', source: 'explicit', extension: '.txt'
  });
  // explicit takes priority even when the extension is unknown
  assert.deepEqual(mimeFor('blob.zzz', 'application/pdf'), {
    mimeType: 'application/pdf', source: 'explicit', extension: '.zzz'
  });
});

test('an absent override (undefined or null) falls through to the extension', () => {
  assert.equal(mimeFor('a.pdf').source, 'extension');
  assert.equal(mimeFor('a.pdf', undefined).source, 'extension');
  assert.equal(mimeFor('a.pdf', null).source, 'extension');
  assert.equal(mimeFor('a.pdf', undefined).mimeType, 'application/pdf');
});

test('invalid explicit values are rejected instead of silently accepted', () => {
  const invalid = [
    '',
    '   ',
    'not-a-mime',
    'application/',
    '/pdf',
    'application',
    'application/pdf/extra',
    'app lication/pdf',
    'application/*',
    'application/pdf; charset=utf-8',
    42,
    {},
    []
  ];
  for (const value of invalid) {
    assert.throws(
      () => mimeFor('a.pdf', value),
      { message: 'Invalid mimeType' },
      JSON.stringify(value) + ' must be rejected'
    );
  }
});

test('invalid file paths are rejected', () => {
  const invalid = [undefined, null, '', '   ', 42, {}, []];
  for (const value of invalid) {
    assert.throws(
      () => mimeFor(value),
      { message: 'Invalid file path' },
      JSON.stringify(value) + ' must be rejected'
    );
  }
  // a bad path wins over a bad explicit value
  assert.throws(() => mimeFor('', 'not-a-mime'), { message: 'Invalid file path' });
});

test('mimeFor agrees with real files written to a temp directory', () => {
  const temp = mkdtempSync(join(tmpdir(), 'upload-mime-'));
  try {
    const names = [
      'report.pdf',
      'notes.docx',
      'archive.zip',
      'picture.PNG',
      'blob.unknownext',
      'noextension'
    ];
    for (const name of names) {
      writeFileSync(join(temp, name), 'x');
    }
    for (const name of names) {
      const full = join(temp, name);
      const stat = statSync(full);
      assert.equal(stat.isFile(), true, name + ' must exist as a real file');
      // A real filesystem path must resolve exactly like its literal basename.
      assert.deepEqual(mimeFor(full), mimeFor(name),
        name + ': real path and literal path must agree');
      assert.equal(mimeFor(full).extension, extname(name).toLowerCase());
    }
    // Concrete boundary checks on the mandated shapes.
    const pdf = mimeFor(join(temp, 'report.pdf'));
    assert.equal(pdf.mimeType, 'application/pdf');
    assert.equal(pdf.source, 'extension');
    assert.equal(mimeFor(join(temp, 'notes.docx')).mimeType, EXPECTED['.docx']);
    const unknown = mimeFor(join(temp, 'blob.unknownext'));
    assert.equal(unknown.source, 'fallback');
    assert.equal(unknown.mimeType, 'application/octet-stream');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
