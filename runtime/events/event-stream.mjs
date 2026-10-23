export class EmbuddiesEventStream {
  #events = [];
  #listener;

  constructor(listener = () => {}) {
    this.#listener = listener;
  }

  emit(event) {
    this.#events.push(event);
    this.#listener(event);
    return event;
  }

  values() {
    return [...this.#events];
  }
}
