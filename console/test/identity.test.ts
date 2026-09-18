// 设备身份的基础函数:MAC 规范化、Client-Id 解析与哈希、绑定码、身份异常记录。

import { strict as assert } from 'node:assert';
import { beforeEach, describe, test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { all, one, openMemoryDb, run, type Db } from '../src/db.ts';
import { seed } from '../src/seed.ts';
import {
  MAX_EVENT_FPS_PER_MAC, canonicalMac, hashClientId, newBindCode, parseClientId, recordIdentityEvent, sameHash,
} from '../src/identity.ts';

describe('MAC 规范化', () => {
  test('大写与连字符统一成小写冒号形式', () => {
    assert.equal(canonicalMac('AA-BB-CC-DD-EE-FF'), 'aa:bb:cc:dd:ee:ff');
    assert.equal(canonicalMac(' 4c:11:ae:31:7a:30 '), '4c:11:ae:31:7a:30');
  });

  test('12 位紧凑形式也认(前端把 MAC 拼进 URL 就是这么写的)', () => {
    assert.equal(canonicalMac('4c11ae317a30'), '4c:11:ae:31:7a:30');
    assert.equal(canonicalMac('4C11AE317A30'), '4c:11:ae:31:7a:30');
    assert.equal(canonicalMac('4c11ae317a3'), null);
    assert.equal(canonicalMac('4c11ae317a300'), null);
    assert.equal(canonicalMac('000000000000'), null);
  });

  test('非十六进制、长度不对、全零与非字符串一律拒绝', () => {
    // 旧正则 [0-9A-Za-z] 会放过 zz 这样的值
    assert.equal(canonicalMac('zz:bb:cc:dd:ee:ff'), null);
    assert.equal(canonicalMac('aa:bb:cc:dd:ee'), null);
    assert.equal(canonicalMac('00:00:00:00:00:00'), null);
    assert.equal(canonicalMac(undefined), null);
    assert.equal(canonicalMac(123), null);
  });
});

describe('Client-Id 解析', () => {
  test('64 位十六进制被接受,大写统一为小写', () => {
    const secret = randomBytes(32).toString('hex');
    assert.equal(parseClientId(secret), secret);
    assert.equal(parseClientId(secret.toUpperCase()), secret);
  });

  test('原版小智固件的 UUID 被接受', () => {
    const uuid = randomUUID();
    assert.equal(parseClientId(uuid), uuid);
  });

  test('由 MAC 推出的旧值、长度不对、非十六进制、全同字符都拒绝', () => {
    assert.equal(parseClientId('xiaodan-aabbcc'), null, '旧固件的 Client-Id 由 MAC 推出,不是秘密');
    assert.equal(parseClientId('aa:bb:cc:dd:ee:ff'), null, '引擎缺头时用 MAC 兜底,也不能当密钥');
    assert.equal(parseClientId('a'.repeat(63) + 'b'.slice(1)), null);
    assert.equal(parseClientId('g'.repeat(64)), null);
    assert.equal(parseClientId('0'.repeat(64)), null, '全零是坏数据');
    assert.equal(parseClientId('f'.repeat(64)), null, '擦除后的闪存是全 f');
    assert.equal(parseClientId(null), null);
  });
});

describe('哈希', () => {
  test('稳定、64 位十六进制、不等于原文,不同输入不同结果', () => {
    const secret = randomBytes(32).toString('hex');
    const hash = hashClientId(secret);
    assert.equal(hash, hashClientId(secret));
    assert.match(hash, /^[0-9a-f]{64}$/u);
    assert.notEqual(hash, secret);
    assert.notEqual(hash, hashClientId(randomBytes(32).toString('hex')));
  });

  test('比较:相同为真,不同、长度不对、非字符串为假', () => {
    const a = hashClientId('x');
    assert.equal(sameHash(a, a), true);
    assert.equal(sameHash(a, hashClientId('y')), false);
    assert.equal(sameHash(a, a.slice(0, 62)), false);
    assert.equal(sameHash(a, null), false);
  });
});

describe('绑定码', () => {
  let conn: Db;
  beforeEach(() => {
    conn = openMemoryDb();
    seed(conn);
  });

  const occupy = (code: string) =>
    run(
      conn,
      "INSERT INTO pending_devices (mac, secret_hash, code, expires_at) VALUES (?, ?, ?, datetime('now', '+10 minutes'))",
      `aa:bb:cc:dd:ee:${code.slice(-2)}`, hashClientId(code), code,
    );

  test('不足六位时补零', () => {
    assert.equal(newBindCode(conn, () => 7), '000007');
  });

  test('与已占用的码冲突时换一个', () => {
    occupy('000001');
    const draws = [1, 2];
    assert.equal(newBindCode(conn, () => draws.shift()!), '000002');
  });

  test('一直冲突时报错而不是死循环', () => {
    occupy('000001');
    assert.throws(() => newBindCode(conn, () => 1), /无法生成/u);
  });
});

describe('身份异常记录', () => {
  let conn: Db;
  beforeEach(() => {
    conn = openMemoryDb();
    seed(conn);
  });

  test('同一冒充者重复出现只累加次数', () => {
    const hash = hashClientId('attacker');
    recordIdentityEvent(conn, { mac: 'aa:bb:cc:dd:ee:01', kind: 'mismatch', source: 'ota', hash });
    recordIdentityEvent(conn, { mac: 'aa:bb:cc:dd:ee:01', kind: 'mismatch', source: 'ota', hash });
    const rows = all<{ count: number; client_fp: string }>(conn, 'SELECT count, client_fp FROM identity_events');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.count, 2);
    assert.equal(rows[0]!.client_fp, hash.slice(0, 12), '只存哈希前 12 位');
  });

  test('同一 MAC 换着密钥来,超过上限后合并记录,不会把表刷满', () => {
    for (let i = 0; i <= MAX_EVENT_FPS_PER_MAC + 3; i++) {
      recordIdentityEvent(conn, { mac: 'aa:bb:cc:dd:ee:02', kind: 'mismatch', source: 'engine', hash: hashClientId(`k${i}`) });
    }
    const distinct = one<{ n: number }>(
      conn, "SELECT COUNT(*) AS n FROM identity_events WHERE mac = ? AND client_fp <> '*'", 'aa:bb:cc:dd:ee:02',
    )!.n;
    const merged = one<{ count: number }>(
      conn, "SELECT count FROM identity_events WHERE mac = ? AND client_fp = '*'", 'aa:bb:cc:dd:ee:02',
    );
    assert.equal(distinct, MAX_EVENT_FPS_PER_MAC);
    assert.ok(merged && merged.count === 4, '超出上限的四次应合并进同一行');
  });

  test('同一冒充者先后出现在 OTA 与引擎两处,不多占指纹名额', () => {
    const mac = 'aa:bb:cc:dd:ee:03';
    const hashes = Array.from({ length: MAX_EVENT_FPS_PER_MAC }, (_, i) => hashClientId(`same-${i}`));
    for (const hash of hashes) recordIdentityEvent(conn, { mac, kind: 'mismatch', source: 'ota', hash });
    // 名额已满,但这些都是出现过的指纹,换个来源再出现时仍应各自记名,而不是被合并成 '*'
    for (const hash of hashes) recordIdentityEvent(conn, { mac, kind: 'mismatch', source: 'engine', hash });
    assert.equal(
      one<{ n: number }>(conn, "SELECT COUNT(*) AS n FROM identity_events WHERE mac = ? AND client_fp = '*'", mac)!.n,
      0,
    );
  });
});
