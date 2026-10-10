import { describe, expect, it } from 'vitest';
import { checkAll, checkBytes, fixBytes } from '../scripts/check-polyglot-line-endings.ts';

const polyglot = (header: string, body: string, batch: string) =>
  Buffer.from(
    [':<<"::CMDLITERAL"', '@ECHO OFF', '::CMDLITERAL'].join(header) +
      header +
      ['set -eu', 'exec true'].join(body) +
      body +
      [':CMDSCRIPT', 'exit /B 0'].join(batch) +
      batch,
  );

describe('polyglot line endings', () => {
  it('tracked .cmd files match the expected structure', () => {
    expect(checkAll()).toEqual([]);
  });

  it('accepts CRLF header and batch with an LF bash body', () => {
    expect(checkBytes('x.cmd', polyglot('\r\n', '\n', '\r\n'))).toEqual([]);
  });

  it('reports a CRLF bash body', () => {
    expect(checkBytes('x.cmd', polyglot('\r\n', '\r\n', '\r\n'))).toEqual([
      'x.cmd:4: expected LF, got CRLF',
      'x.cmd:5: expected LF, got CRLF',
    ]);
  });

  it('reports LF in a pure batch file', () => {
    expect(checkBytes('x.cmd', Buffer.from('@ECHO OFF\r\nexit /B 0\n'))).toEqual(['x.cmd:2: expected CRLF, got LF']);
  });

  it('fix restores the polyglot structure', () => {
    expect(fixBytes(polyglot('\n', '\r\n', '\n'))).toEqual(polyglot('\r\n', '\n', '\r\n'));
  });

  it('reports and does not fix a polyglot file without :CMDSCRIPT', () => {
    const broken = Buffer.from(':<<"::CMDLITERAL"\r\n::CMDLITERAL\r\nset -eu\n');
    expect(checkBytes('x.cmd', broken)).toEqual(["x.cmd: missing ':CMDSCRIPT' label line"]);
    expect(fixBytes(broken)).toBeNull();
  });
});
