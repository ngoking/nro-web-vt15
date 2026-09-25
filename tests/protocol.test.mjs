import assert from 'node:assert/strict';
import test from 'node:test';
import { ByteWriter, NroProtocol } from '../web/protocol.js';

function decodeFrame(frame, key) {
  let cursor = 0;
  const bytes = Array.from(frame, byte => {
    const value = byte ^ key[cursor];
    cursor = (cursor + 1) % key.length;
    return value;
  });
  return { command: bytes[0] > 127 ? bytes[0] - 256 : bytes[0], payload: bytes.slice(3) };
}

test('requests the four update groups and finishes only after sync', () => {
  const protocol = new NroProtocol();
  protocol.key = new Uint8Array([19, 71, 143]);
  protocol.keyReady = true;
  for (const [make, command, payload] of [
    ['makeUpdateData', -87, []],
    ['makeUpdateMap', -28, [6]],
    ['makeUpdateSkill', -28, [7]],
    ['makeUpdateItem', -28, [8]],
    ['makeClientOk', -28, [13]],
    ['makeFinishUpdate', -38, []],
  ]) {
    protocol.curW = 0;
    assert.deepEqual(decodeFrame(protocol[make](), protocol.key), { command, payload });
  }
});

test('map ID and zone are parsed separately from version numbers', () => {
  const protocol = new NroProtocol();
  const map = new ByteWriter()
    .byte(64).byte(1).byte(2).byte(3).byte(4).utf('Núi dây leo').byte(5)
    .finish();
  assert.deepEqual(protocol.parseMapInfo(map), {
    mapId: 64, planetId: 1, tileId: 2, backgroundId: 3,
    mapType: 4, mapName: 'Núi dây leo', zoneId: 5,
  });
});
