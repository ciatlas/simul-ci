import type { ReplaceChoice } from '../input/sources';
import type { SessionStore } from '../state/store';

/**
 * The replace prompt as a promise (synthesis § 5.7): `ask` shows it through the store's `replacing` and waits for
 * the author's answer, which the dialog gives with `answer`. A new question answers an open one Cancel, so one prompt
 * is open at a time.
 */
export interface ReplacePrompt {
  ask(what: string): Promise<ReplaceChoice>;
  answer(choice: ReplaceChoice): void;
}

export function createReplacePrompt(store: SessionStore): ReplacePrompt {
  let seq = 0;
  let open: ((choice: ReplaceChoice) => void) | undefined;
  return {
    ask: (what) => {
      open?.('cancel');
      store.getState().setReplacing({ seq: ++seq, what });
      return new Promise((resolve) => {
        open = resolve;
      });
    },
    answer: (choice) => {
      const resolve = open;
      open = undefined;
      store.getState().setReplacing(undefined);
      resolve?.(choice);
    },
  };
}
