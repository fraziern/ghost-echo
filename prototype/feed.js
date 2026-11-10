/*
 * Simulated transcript feed: emits words at a speech-like, slightly irregular pace, with pauses
 * between sentences. Driven by tick(dt) from the animation loop (no timers), so it is deterministic
 * with the "?warp=" test parameter. In the real app this is replaced by WebSocket partial/final messages.
 * All text here is made-up placeholder copy.
 */
(function () {
  'use strict';

  const SENTENCES = [
    'Everything said in this room is heard once, written down for a moment, and then let go.',
    'Nothing here is saved. The words rise, break apart, and drift away like dust in the afternoon light.',
    'Speak naturally and watch the text climb the screen before it fades.',
    'This is a prototype, so the sentences are only pretend, but the motion is real.',
    'Short ones too.',
    'Pixels soften as the words pass the middle of the window, then scatter when they reach the top.',
    'There is no transcript to find later, no history to scroll back through, and nothing to delete.',
    'Privacy by design means the forgetting is built in from the very first word.',
    'Try changing the colors, the size of the type, or the way the dust blows.',
    'Long pauses are fine as well; the screen simply keeps letting go of whatever is already there.',
  ];

  class SimulatedFeed {
    constructor() {
      this.wps = 2.5;
      this.paused = false;
      this._sentence = 0;
      this._words = [];
      this._k = 0;
      this._wait = 0.6;
    }

    /** Advance by dt seconds; calls emit(word) for each word that is "spoken" in that time. */
    tick(dt, emit) {
      if (this.paused) return;
      this._wait -= dt;
      while (this._wait <= 0) {
        if (this._k >= this._words.length) {
          this._words = SENTENCES[this._sentence++ % SENTENCES.length].split(' ');
          this._k = 0;
          // Gap between sentences; now and then a long silence.
          this._wait += Math.random() < 0.2 ? 3 + Math.random() * 3 : 0.5 + Math.random() * 1.2;
          continue;
        }
        const word = this._words[this._k++];
        emit(word);
        let gap = (1 / this.wps) * (0.6 + 0.8 * Math.random());
        if (/[,;]$/.test(word)) gap *= 1.8;
        this._wait += gap;
      }
    }
  }

  window.SimulatedFeed = SimulatedFeed;
})();
