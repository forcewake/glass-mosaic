/**
 * The search toolbar: a plain `<input type="search">` in a `role="search"`
 * form. On the glasses, focusing it and pressing Enter opens the system
 * text composer, which only delivers `input` / `change` events (no key
 * events), so the toolbar reacts to those, never to keystrokes.
 */
export interface ToolbarCallbacks {
  /** Live typing (debounced): reframe the mosaic, keep focus in the field. */
  onPreview: (query: string) => void;
  /** Committed query (composer closed, Enter, change): reframe and focus the best hit. */
  onCommit: (query: string) => void;
  onClear: () => void;
  /** Arrow Down out of the toolbar. */
  onExitDown: () => void;
}

export class Toolbar {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  private clear: HTMLButtonElement;
  private status: HTMLParagraphElement;
  private timer = 0;

  constructor(host: HTMLElement, private callbacks: ToolbarCallbacks) {
    const header = document.createElement('header');
    header.className = 'toolbar';
    header.innerHTML = `
      <form class="search" role="search" action="#" autocomplete="off">
        <label class="visually-hidden" for="search-input">Search the mosaic</label>
        <input id="search-input" class="search-input" type="search" name="q" enterkeyhint="search"
          autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="80"
          placeholder="Search: mountains, rain, video…" />
        <button type="button" class="search-clear" hidden>Clear</button>
      </form>
      <p class="status" role="status" aria-live="polite"></p>`;
    host.append(header);
    this.element = header;
    this.input = header.querySelector('input')!;
    this.clear = header.querySelector('.search-clear')!;
    this.status = header.querySelector('.status')!;

    const form = header.querySelector('form')!;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.commit();
    });
    this.input.addEventListener('input', () => {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.callbacks.onPreview(this.input.value), 250);
    });
    this.input.addEventListener('change', () => this.commit());
    this.input.addEventListener('search', () => {
      // Fired by the native clear (x) affordance of type=search, and by Enter.
      if (!this.input.value) this.commit();
    });
    this.clear.addEventListener('click', () => this.callbacks.onClear());

    header.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.callbacks.onExitDown();
      } else if (event.key === 'ArrowRight' && target === this.input && !this.clear.hidden) {
        if (this.input.selectionStart === this.input.value.length) {
          event.preventDefault();
          this.clear.focus();
        }
      } else if (event.key === 'ArrowLeft' && target === this.clear) {
        event.preventDefault();
        this.input.focus();
      }
    });
  }

  private commit(): void {
    window.clearTimeout(this.timer);
    this.callbacks.onCommit(this.input.value);
  }

  /** Sets the field value without triggering a search (history restore, agent tools). */
  setQuery(query: string): void {
    window.clearTimeout(this.timer);
    this.input.value = query;
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  setHasResults(has: boolean): void {
    this.clear.hidden = !has;
  }

  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  /** Height covered at the top of the viewport, in CSS px. */
  get inset(): number {
    return this.element.offsetHeight + 8;
  }
}
