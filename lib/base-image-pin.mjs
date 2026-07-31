/**
 * Single source of truth for the OpenClaw base image pin.
 *
 * The Dockerfile FROM and the /capabilities payload must always describe the
 * same base image; base-image-pin.test.mjs enforces that lockstep by parsing
 * the Dockerfile ARG default and asserting strict equality with the constant
 * below. Everything layered on top of the base (vendor CLI versions, bridge
 * code) is version-pinned, so a floating base tag was the one input that made
 * image rebuilds non-reproducible — the runtime-upgrade system already rejects
 * floating targets for the same reason.
 *
 * Bump procedure (one PR, both files):
 *   docker buildx imagetools inspect ghcr.io/openclaw/openclaw:latest
 *   → copy the manifest digest into OPENCLAW_BASE_IMAGE here AND the
 *     ARG OPENCLAW_BASE_IMAGE default in the Dockerfile; CI runs the
 *     lockstep test.
 */

export const OPENCLAW_BASE_IMAGE =
  'ghcr.io/openclaw/openclaw@sha256:25f5bacf51742c3231d7dd1d319fede009a9d5aeab8b6232cd309ac6475fe82c';

export const OPENCLAW_BASE_IMAGE_TAG_HINT = 'latest';
