/* Web Worker wrapper for the free-check engine: receives decoded mono
   PCM (transferred), runs verification off the main thread, posts
   progress and the final result. */

import { verify } from './fp-core.js';

self.onmessage = async (e) => {
  const { creativePcm, episodePcm } = e.data;
  try {
    const result = await verify(creativePcm, episodePcm, (stage, p) => {
      self.postMessage({ type: 'progress', stage, p });
    });
    self.postMessage({ type: 'result', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message ?? err) });
  }
};
