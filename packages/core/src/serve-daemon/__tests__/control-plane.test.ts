import { describe, expect, it } from 'vitest';

import {
  CONTROL_PLANE_HEADER,
  CONTROL_PLANE_MARKER,
  isControlPlaneConnection,
  isLoopbackAddress,
} from '../control-plane.js';

describe('control-plane marker', () => {
  it('exposes a lowercase header name and a non-empty marker value', () => {
    expect(CONTROL_PLANE_HEADER).toBe(CONTROL_PLANE_HEADER.toLowerCase());
    expect(CONTROL_PLANE_MARKER.length).toBeGreaterThan(0);
  });
});

describe('isLoopbackAddress', () => {
  it('accepts IPv4 loopback addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.5.6.7')).toBe(true);
  });

  it('accepts IPv6 loopback addresses', () => {
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('0:0:0:0:0:0:0:1')).toBe(true);
  });

  it('accepts IPv4-mapped IPv6 loopback addresses', () => {
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects non-loopback and missing addresses', () => {
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
    expect(isLoopbackAddress('192.168.1.5')).toBe(false);
    expect(isLoopbackAddress('::ffff:10.0.0.1')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
  });
});

describe('isControlPlaneConnection', () => {
  it('is true only when the marker is present on a loopback connection', () => {
    expect(isControlPlaneConnection('127.0.0.1', CONTROL_PLANE_MARKER)).toBe(true);
  });

  it('reads the marker from a header-array value', () => {
    expect(isControlPlaneConnection('::1', [CONTROL_PLANE_MARKER])).toBe(true);
  });

  it('is false when the marker is absent even on loopback', () => {
    expect(isControlPlaneConnection('127.0.0.1', undefined)).toBe(false);
    expect(isControlPlaneConnection('127.0.0.1', 'something-else')).toBe(false);
  });

  it('is false when the marker is present but the connection is not loopback', () => {
    expect(isControlPlaneConnection('10.0.0.1', CONTROL_PLANE_MARKER)).toBe(false);
  });
});
